#!/usr/bin/env node
/**
 * Overlay bounds and CSP check for the admin console (BL-29, same rule as
 * web/scripts/overlay-bounds.mjs): at 390 px and 1280 px wide, open each
 * menu, select, popover, dialog, alert dialog and sheet (some near the
 * screen's edges) and fail if any of them leaves the viewport.
 *
 * It runs the production bundle in the `overlays` mode (a mock gateway, no
 * network, no Firebase; src/dev/) under `vite preview`, which sends the real
 * Content-Security-Policy header, and fails on any CSP violation too: a
 * dependency that injects a <style> at runtime shows up here.
 *
 *   node scripts/overlay-bounds.mjs          # builds and serves itself
 *   BASE_URL=http://localhost:4180 node …    # against a running preview
 *
 * `pnpm test:overlays` installs Chromium for the pinned `playwright`
 * devDependency and runs this with REQUIRE_OVERLAY_CHECK=1. Without
 * Playwright the check says so and exits 0, unless REQUIRE_OVERLAY_CHECK=1.
 */

import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const adminDir = path.resolve(here, "..");
const require = createRequire(import.meta.url);

function loadPlaywright() {
  for (const id of [process.env.PLAYWRIGHT_MODULE, "playwright", "@playwright/test"].filter(Boolean)) {
    try {
      return require(id);
    } catch {
      // next
    }
  }
  return null;
}

const pw = loadPlaywright();
if (!pw) {
  const msg = "overlay-bounds: Playwright not found (set PLAYWRIGHT_MODULE); skipped.";
  if (process.env.REQUIRE_OVERLAY_CHECK === "1") {
    console.error(msg);
    process.exit(1);
  }
  console.log(msg);
  process.exit(0);
}

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const vite = path.join(adminDir, "node_modules", ".bin", "vite");
let server = null;
let base = process.env.BASE_URL;
if (!base) {
  execFileSync(vite, ["build", "--mode", "overlays", "--outDir", "dist-overlays", "--emptyOutDir"], {
    cwd: adminDir,
    stdio: "ignore",
  });
  const port = await freePort();
  base = `http://localhost:${port}`;
  server = spawn(vite, ["preview", "--mode", "overlays", "--outDir", "dist-overlays", "--port", String(port), "--strictPort"], {
    cwd: adminDir,
    stdio: "ignore",
    detached: true,
  });
  if (!(await waitFor(`${base}/cases`, 60_000))) {
    console.error("overlay-bounds: the preview server didn't start");
    process.kill(-server.pid);
    process.exit(1);
  }
}

const OVERLAY = [
  '[data-slot="popover-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="select-content"]',
  '[data-slot="tooltip-content"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(", ");

/** Every open overlay's box must sit inside the viewport. */
async function assertInside(page, label, failures) {
  await page.waitForSelector(OVERLAY, { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(350); // let the open animation finish
  const vp = page.viewportSize();
  const boxes = await page.$$eval(OVERLAY, (els) =>
    els
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }),
  );
  for (const b of boxes) {
    const out = b.left < -0.5 || b.top < -0.5 || b.right > vp.width + 0.5 || b.bottom > vp.height + 0.5;
    if (out) failures.push(`${label} @${vp.width}: ${JSON.stringify(b)}`);
  }
}

async function close(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

/** Opens an overlay with `open`, checks it, closes it with Escape. */
async function check(page, label, failures, open, closes = 1) {
  try {
    await open();
    await assertInside(page, label, failures);
  } catch (e) {
    failures.push(`${label} @${page.viewportSize().width}: couldn't open (${String(e.message).split("\n")[0]})`);
  }
  for (let i = 0; i < closes; i++) await close(page);
}

const failures = [];
const csp = [];
const browser = await pw.chromium.launch();
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: "dark" });
    page.setDefaultTimeout(20_000);
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        (window.__csp ||= []).push(`${e.violatedDirective} ${e.blockedURI || "inline"} ${e.sample || ""}`.trim());
      });
    });
    page.on("console", (m) => {
      if (m.type() === "error" && /Content Security Policy/i.test(m.text())) csp.push(`@${width}: ${m.text()}`);
    });
    const button = (name) => page.getByRole("button", { name, exact: true }).first();
    const combobox = (name) => page.getByRole("combobox", { name }).first();

    // Cases: header menu (right edge), a filter, the command palette
    await page.goto(`${base}/cases`);
    await page.getByText("CASE-0042").first().waitFor();
    await check(page, "Account menu", failures, () => button("Account menu").click());
    if (width < 768) await check(page, "Phone nav sheet", failures, () => button("Menu").click());
    await check(page, "Type filter", failures, () => combobox("Type").click());
    const search = page.getByRole("button", { name: /^Search/ }).first();
    if (await search.count()) await check(page, "Command palette", failures, () => search.click());

    // Case: money confirms (AlertDialog), a Sheet and a Dialog
    await page.goto(`${base}/cases/CASE-0042`);
    await button("Approve $49.72").waitFor();
    await check(page, "Approve alert", failures, () => button("Approve $49.72").click());
    await check(page, "Partial alert", failures, () => button("Partial…").click());
    await check(page, "Ask sheet", failures, () => button("Ask the customer…").click());
    await check(page, "Close dialog", failures, () => button("Close").click());

    // Account: grant (alert with a select inside), revoke, open a case (sheet)
    await page.goto(`${base}/accounts/uid_123`);
    await button("Grant Pro…").waitFor();
    await check(
      page,
      "Grant Pro alert + entitlement select",
      failures,
      async () => {
        await button("Grant Pro…").click();
        await page.getByRole("alertdialog").getByRole("combobox", { name: "Entitlement" }).click();
      },
      2,
    );
    await check(page, "Revoke alert", failures, () => button("Revoke…").click());
    await check(page, "Open a case sheet", failures, () => button("Open a case…").click());

    // Disputes: the "?" popover and the months select (right side)
    await page.goto(`${base}/disputes`);
    await page.getByText("dispute activity").first().waitFor();
    await check(page, "Activity popover", failures, () => page.getByRole("button", { name: "About dispute activity" }).click());
    await check(page, "Months select", failures, () => combobox("Months").click());

    // Security: add (dialog) and remove the long-named passkey (alert)
    await page.goto(`${base}/security`);
    await page.getByTestId("passkey-pk_2").waitFor();
    await check(page, "Add a passkey dialog", failures, () => button("Add a passkey").click());
    await check(page, "Remove passkey alert", failures, () => page.getByRole("button", { name: /^Remove A passkey/ }).click());

    const violations = await page.evaluate(() => window.__csp || []);
    for (const v of violations) csp.push(`@${width}: ${v}`);
    await page.close();
  }
} finally {
  await browser.close();
  if (server) process.kill(-server.pid);
}

let failed = false;
if (failures.length) {
  failed = true;
  console.error(`overlay-bounds: ${failures.length} overlay problem(s):\n  ${failures.join("\n  ")}`);
}
if (csp.length) {
  failed = true;
  console.error(`overlay-bounds: ${csp.length} CSP violation(s):\n  ${[...new Set(csp)].join("\n  ")}`);
}
if (failed) process.exit(1);
console.log("overlay-bounds: every overlay stays inside the viewport at 390 and 1280 px, with no CSP violations");
