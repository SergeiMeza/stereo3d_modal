/**
 * Arabic, right to left (owner 2026-11-07): the quote, the Make 3D panel
 * and Run details render under dir="rtl" with logical spacing only (no
 * left/right utilities outside the parts that stay left to right: the
 * part-of-video range, the timeline, media), mirrored arrows, number runs
 * isolated, and the Arabic messages where they exist (English per key
 * where they don't yet). With RTL_SNAPSHOT_DIR set, each screen's HTML is
 * written there for a browser screenshot.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { clearStepQuotes } from "@/components/steps/checkoutStore";
import { HistoryList } from "@/components/steps/HistoryList";
import { LifelikeDeliverPanel } from "@/components/steps/LifelikeDeliverPanel";
import { QuoteView } from "@/components/steps/QuoteView";
import type { Conversion, Project, StepQuoteResponse } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import ar from "../../../messages/ar.json";
import projectFixture from "../../../fixtures/project.json";

import { formatCents } from "@/components/steps/money";

import { ltrRuns } from "./bidi";
import { I18nProvider } from "./I18nProvider";
import { makeTr, type Messages } from "./t";

vi.mock("@/components/steps/polling", () => ({ POLL_INTERVAL_MS: 40 }));

const AR = ar as Messages;
const PID = (projectFixture as { project_id: string }).project_id;
const SNAP = process.env.RTL_SNAPSHOT_DIR;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  document.documentElement.lang = "ar";
  document.documentElement.dir = "rtl";
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  act(() => clearStepQuotes());
  resetPricingCache();
  mockDb.reset();
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";
});
afterAll(() => server.close());

function inArabic(node: ReactNode) {
  return render(
    <I18nProvider locale="ar" messages={AR}>
      <div dir="rtl">{node}</div>
    </I18nProvider>,
  );
}

/** left/right utilities outside the subtrees that stay left to right */
function physicalClasses(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[class]")) {
    if (el.closest('[dir="ltr"]')) continue;
    for (const c of (el.getAttribute("class") ?? "").split(/\s+/)) {
      const base = c.split(":").at(-1) ?? "";
      if (/^-?(ml|mr|pl|pr)-|^-?(left|right)-(?!1\/2$)|^text-(left|right)$|^rounded-([lr]|[tb][lr])(-|$)|^border-[lr](-|$)/.test(base)) {
        out.push(c);
      }
    }
  }
  return out;
}

function snapshot(name: string, root: HTMLElement): void {
  if (!SNAP) return;
  mkdirSync(SNAP, { recursive: true });
  writeFileSync(join(SNAP, `${name}.html`), `<html lang="ar" dir="rtl"><body class="bg-surface-0 text-fg">${root.innerHTML}</body></html>`);
}

describe("number runs keep their order in Arabic", () => {
  it("wraps ranges, sizes, prices and units; leaves other languages alone", () => {
    const arT = makeTr("ar", AR);
    const L = "⁦";
    const P = "⁩";
    expect(ltrRuns("0:01 – 0:06 · 5 s", arT)).toBe(`${L}0:01 – 0:06${P} · ${L}5 s${P}`);
    expect(ltrRuns("1080p · 1920×1080 لكل عين", arT)).toBe(`${L}1080p${P} · ${L}1920×1080${P} لكل عين`);
    expect(ltrRuns("$12.00", arT)).toBe(`${L}$12.00${P}`);
    expect(ltrRuns("Vision Pro .mov، جنبًا إلى جنب .mp4", arT)).toBe(`${L}Vision Pro .mov${P}، جنبًا إلى جنب ${L}.mp4${P}`);
    expect(ltrRuns("جودة +30%", arT)).toBe(`جودة ${L}+30%${P}`);
    // an amount already isolated stays as it is
    expect(ltrRuns(`${L}12.00 US$${P} · 4K`, arT)).toBe(`${L}12.00 US$${P} · ${L}4K${P}`);
    expect(ltrRuns("1920×1080 per eye", makeTr("en", null))).toBe("1920×1080 per eye");
    // amounts in Arabic: Latin digits, isolated
    expect(formatCents(1200, arT)).toMatch(/^\u2066.*12\.00.*\u2069$/u);
  });
});

describe("Arabic: the quote, Make 3D and Run details", () => {
  it("the quote: right to left, values isolated, no physical spacing", () => {
    const result: StepQuoteResponse = {
      step: "production",
      method: "lifelike",
      params: { preset: "qhd", formats: ["mvhevc"] },
      quote: {
        amount_cents: 675,
        currency: "usd",
        breakdown: {
          step: "production",
          preset: "qhd",
          billable_seconds: 120,
          fps_factor: 1,
          list_cents_per_minute: 450,
          cents_per_minute: 450,
          list_base_cents: 900,
          subtotal_cents: 900,
          campaign_cents: 225,
          campaign_label: "Launch offer −25%",
        },
      },
      reuse_stages: null,
    };
    const { container } = inArabic(<QuoteView result={result} />);
    const total = screen.getByTestId("quote-total");
    // set in mono: isolated left to right by globals.css
    expect(total.className).toContain("font-mono");
    expect(total.textContent).toMatch(/\d/);
    expect(physicalClasses(container)).toEqual([]);
    snapshot("quote", container);
  });

  it("Make 3D: Arabic where translated, the part range left to right, no physical spacing", async () => {
    mockDb.tierPricing = true;
    const p = mockDb.projects.get(PID)!;
    p.method = "lifelike";
    const project = structuredClone({ ...p, conversions: [] }) as Project;
    const { container } = inArabic(
      <AuthProvider>
        <LifelikeDeliverPanel project={project} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    await screen.findByTestId("quote-breakdown", {}, { timeout: 4000 });
    expect(physicalClasses(container)).toEqual([]);
    // the range over the video stays left to right
    const range = screen.getAllByRole("slider").find((s) => s.closest('[dir="ltr"]'));
    expect(range).toBeTruthy();
    snapshot("make3d", container);
  });

  it("Run details: Arabic labels, number runs isolated, no physical spacing", () => {
    const run: Conversion = {
      conversion_id: "rtl_run_1",
      state: "succeeded",
      kind: "video",
      project_id: PID,
      step: "production",
      method: "lifelike",
      params: { preset: "1080p", formats: ["mvhevc", "sbs"], from_frame: 24, to_frame: 144 },
      quote: { amount_cents: 1200, currency: "usd", breakdown: { step: "production" } },
      billing: { status: "charged", charged_cents: 1200 },
      progress: 1,
      outputs: ["mvhevc", "sbs"],
      quality: "high",
      started_at: "2026-11-07T09:02:00Z",
      intro: false,
      created_at: "2026-11-07T09:00:00Z",
      updated_at: "2026-11-07T09:12:00Z",
    } as Conversion;
    mockDb.conversions.set(run.conversion_id, structuredClone(run));
    const project = { ...(structuredClone(projectFixture) as unknown as Project), method: "lifelike", conversions: [run] } as Project;
    const { container } = inArabic(
      <AuthProvider>
        <BillingProvider>
          <HistoryList project={project} />
        </BillingProvider>
      </AuthProvider>,
    );
    const li = screen.getByTestId("history-rtl_run_1");
    fireEvent.click(within(li).getByTestId("run-details-toggle"));
    const panel = within(li).getByTestId("run-details");
    // the labels are the Arabic ones (files.details.rows.*)
    const rows = (AR.files as Messages).details as Messages;
    const part = within(li).getByTestId("detail-Part");
    expect(part.querySelector("dt")?.textContent).toBe((rows.rows as Messages).part);
    // the range and its length are isolated runs
    expect(part.querySelector("dd")?.textContent).toContain("⁦");
    expect(physicalClasses(panel)).toEqual([]);
    snapshot("run-details", container);
  });
});
