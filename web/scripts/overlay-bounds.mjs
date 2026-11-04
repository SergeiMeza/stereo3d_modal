#!/usr/bin/env node
/**
 * Overlay bounds check (owner 2026-11-04): at 390 px and 1280 px wide, open
 * each popover, menu and sheet (some near the screen's edges) against the
 * mock gateway and fail if any of them leaves the viewport; the project's
 * Overview, Make 3D and Files pages (a long file name, black bars) must
 * not scroll sideways (owner 2026-11-05, iPhone).
 *
 *   node scripts/overlay-bounds.mjs            # starts `next dev` (mock) itself
 *   BASE_URL=http://localhost:3931 node …      # against a running dev server
 *
 * `pnpm test:overlays` installs Chromium for the pinned `playwright`
 * devDependency and runs this with REQUIRE_OVERLAY_CHECK=1 (CI runs it).
 * PLAYWRIGHT_MODULE can point at another install. Without Playwright the
 * check says so and exits 0, unless REQUIRE_OVERLAY_CHECK=1.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
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
      if (r.ok || r.status === 404) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

let server = null;
let base = process.env.BASE_URL;
if (!base) {
  const port = await freePort();
  base = `http://localhost:${port}`;
  server = spawn("npx", ["next", "dev", "-p", String(port)], {
    cwd: webDir,
    env: { ...process.env, NEXT_PUBLIC_API_MOCK: "1" },
    stdio: "ignore",
    detached: true,
  });
  if (!(await waitFor(`${base}/pricing`, 180_000))) {
    console.error("overlay-bounds: the dev server didn't start");
    process.kill(-server.pid);
    process.exit(1);
  }
}

const OVERLAY = '[data-slot="popover-content"], [data-slot="dropdown-menu-content"], [role="dialog"], [role="alertdialog"]';

/** Every open overlay's box must sit inside the viewport. */
async function assertInside(page, label, failures) {
  await page.waitForSelector(OVERLAY, { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(400); // let the open animation finish
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

/** owner 2026-11-05 (iPhone): the page itself never scrolls sideways. */
async function assertNoSideScroll(page, label, failures) {
  await page.waitForTimeout(600);
  const vp = page.viewportSize();
  const sw = await page.evaluate(() => document.scrollingElement.scrollWidth);
  if (sw > vp.width + 0.5) {
    const wide = await page.evaluate((w) => {
      const el = [...document.querySelectorAll("body *")].find((e) => e.getBoundingClientRect().right > w + 0.5);
      return el ? `${el.tagName}.${String(el.className).slice(0, 80)}` : "?";
    }, vp.width);
    failures.push(`${label} @${vp.width}: page is ${sw} px wide (${wide})`);
  }
}

async function close(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}

const failures = [];
const browser = await pw.chromium.launch();
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: "dark" });
    page.setDefaultTimeout(30_000);
    // a returning account: no welcome, tips or hints in the way
    await page.addInitScript(() => {
      let db;
      Object.defineProperty(window, "__mockDb", {
        configurable: true,
        get: () => db,
        set(v) {
          db = v;
          v.accountSettings.onboarding = { welcome_done: true, tips_done: true, checklist_hidden: true };
          v.accountSettings.hints_seen = ["billing", "usage", "invoices", "plans", "pricing", "pro", "account", "devices", "scenes"];
          // ADR 0136: two passkeys, for Rename and Remove on /account
          v.passkeys = [
            { id: "pk_1", name: "iPhone", device_hint: "iPhone", created_at: "2026-11-01T10:00:00Z", last_used_at: "2026-11-03T10:00:00Z" },
            { id: "pk_2", name: "A passkey with a rather long name for the edge", device_hint: null, created_at: "2026-11-02T10:00:00Z", last_used_at: null },
          ];
        },
      });
    });

    // Pricing: "How pricing works"
    await page.goto(`${base}/pricing`, { waitUntil: "domcontentloaded" });
    const how = page.getByRole("button", { name: "How pricing works" }).first();
    if (await how.count()) {
      await how.click();
      await assertInside(page, "How pricing works", failures);
      await close(page);
    }

    // header: account menu (right edge) and feedback
    await page.getByRole("button", { name: "Account menu" }).click();
    await assertInside(page, "Account menu", failures);
    await close(page);
    await page.getByTestId("feedback-open").click();
    await assertInside(page, "Feedback", failures);
    await close(page);

    // Billing: a payment method's menu (right edge)
    await page.goto(`${base}/account/billing`, { waitUntil: "domcontentloaded" });
    const opts = page.getByRole("button", { name: /^Options for / }).first();
    if (await opts.count().then((n) => n > 0).catch(() => false)) {
      await opts.click();
      await assertInside(page, "Payment method menu", failures);
      await close(page);
    }

    // Business details: the country picker (owner 2026-11-04, ~245 countries)
    await page.goto(`${base}/account/business-details`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("company-country").click();
    await assertInside(page, "Country picker", failures);
    await page.getByPlaceholder("Search countries").fill("vi");
    await assertInside(page, "Country picker (filtered)", failures);
    await close(page);

    // Account → Sign-in & security: passkey dialogs (ADR 0136)
    await page.goto(`${base}/account`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("passkey-pk_2").waitFor({ state: "visible" });
    const addKey = page.getByTestId("passkey-add");
    if (await addKey.count()) {
      await addKey.click();
      await assertInside(page, "Add a passkey dialog", failures);
      await close(page);
    }
    await page.getByRole("button", { name: /^Rename A passkey/ }).click();
    await assertInside(page, "Rename passkey dialog", failures);
    await close(page);
    await page.getByRole("button", { name: /^Remove A passkey/ }).click();
    await assertInside(page, "Remove passkey alert", failures);
    await close(page);

    // Make 3D: the "?" beside the charge rule (right column) and the Pro sheet
    await page.goto(`${base}/projects`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mockDb && window.__mockDb.projects.size > 0);
    const id = await page.evaluate(() => [...window.__mockDb.projects.keys()][0]);
    await page.evaluate((pid) => {
      const p = window.__mockDb.projects.get(pid);
      p.method = "lifelike";
      // a long file name without spaces, and black bars (iPhone, 2026-11-05)
      p.name = "2025_AUTUMN_CAMPAIGN_PREMIUMENDROLL(FHD)_FINAL_MASTER_EXPORT_v12";
      p.has_bars = true;
      p.remove_bars = true;
    }, id);
    // a finished run for the Files tab's "Get another format" (ADR 0137)
    await page.evaluate((pid) => {
      window.__mockDb.conversions.set("conv_overlay_formats", {
        conversion_id: "conv_overlay_formats",
        state: "succeeded",
        kind: "video",
        method: "lifelike",
        project_id: pid,
        step: "production",
        params: { preset: "1080p", formats: ["mvhevc"] },
        quote: { amount_cents: 500, currency: "usd" },
        progress: 1,
        outputs: ["mvhevc"],
        created_at: "2026-11-01T09:00:00Z",
        updated_at: "2026-11-01T09:10:00Z",
      });
    }, id);
    await page.locator(`a[href="/projects/${id}"]`).first().click();
    await page.getByTestId("overview-tab").waitFor({ state: "visible" });
    await assertNoSideScroll(page, "Project Overview", failures);
    await page.getByTestId("tab-make").click();
    await page.getByTestId("lifelike-deliver-panel").waitFor({ state: "visible" });
    await assertNoSideScroll(page, "Make 3D", failures);
    const q = page.getByRole("button", { name: "?" }).last();
    await q.waitFor({ state: "visible" });
    await q.click();
    await assertInside(page, "Make 3D ? popover", failures);
    await close(page);
    const withPro = page.getByTestId("pay-with-pro");
    if (await withPro.count()) {
      await withPro.click();
      await page.getByTestId(width < 640 ? "checkout-main-phone" : "checkout-main").click();
      await assertInside(page, "Pro checkout sheet", failures);
      await close(page);
    }

    // Files: "Get another format" on a finished run (ADR 0137)
    await page.getByTestId("tab-files").click();
    await page.waitForTimeout(800);
    await assertNoSideScroll(page, "Files", failures);
    const another = page.getByTestId("another-format-open").first();
    await another.waitFor({ state: "visible" });
    await another.click();
    await assertInside(page, "Get another format menu", failures);
    await close(page);
    await page.close();
  }
} finally {
  await browser.close();
  if (server) process.kill(-server.pid);
}

if (failures.length) {
  console.error(`overlay-bounds: ${failures.length} overlay(s) leave the viewport:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(
  "overlay-bounds: every overlay stays inside the viewport, and the project pages don't scroll sideways, at 390 and 1280 px",
);
