/**
 * HDR output (owner 2026-11-05): a per-run toggle on Make 3D for an HDR
 * video, off by default, included on every plan and +30% otherwise. While
 * the gateway hasn't turned it on (no hdr_available), nothing says HDR.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PricingScreen } from "@/components/pricing/PricingScreen";
import { ProSaveLink } from "@/components/pricing/ProOffer";
import { ProScreen } from "@/components/pro/ProScreen";
import { planLines } from "@/components/pricing/PlansSection";
import type { PlanDef } from "@/lib/api/types";
import { proIncludesHdr, resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { videoFacts } from "@/lib/glossary";
import { resetProForTests } from "@/lib/pro/usePro";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { LifelikeDeliverPanel } from "./LifelikeDeliverPanel";
import { QuoteView } from "./QuoteView";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 30 }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pricing",
  useSearchParams: () => new URLSearchParams(),
}));

const PID = (projectFixture as { project_id: string }).project_id;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.events.removeAllListeners();
  act(() => clearStepQuotes());
  server.resetHandlers();
  mockDb.reset();
  resetPricingCache();
  resetProForTests();
});
afterAll(() => server.close());

/** The project, as the gateway sends it, with HDR output on or off. */
function project(hdr: { on: boolean; source: boolean }) {
  mockDb.hdrOutput = hdr.on;
  const p = mockDb.projects.get(PID)!;
  p.method = "lifelike";
  Object.assign(p, {
    hdr_source: hdr.source,
    ...(hdr.on ? { hdr_available: true, dynamic_range: hdr.source ? "pq" : "sdr" } : {}),
  });
  return structuredClone({ ...p, conversions: [] });
}

function captureQuotes(): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/quotes")) {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
    }
  });
  return bodies;
}

function panel(p: ReturnType<typeof project>) {
  return render(
    <AuthProvider>
      <LifelikeDeliverPanel project={p} onProjectChanged={() => {}} />
    </AuthProvider>,
  );
}

describe("HDR on Make 3D", () => {
  beforeEach(() => {
    mockDb.tierPricing = true;
    resetPricingCache();
  });

  it("is hidden while HDR output is off, even for an HDR video", async () => {
    panel(project({ on: false, source: true }));
    await screen.findByTestId("addon-master");
    expect(screen.queryByTestId("addon-hdr")).toBeNull();
    expect(document.body.textContent).not.toMatch(/HDR/);
  });

  it("is hidden for a video that isn't HDR", async () => {
    panel(project({ on: true, source: false }));
    await screen.findByTestId("addon-master");
    expect(screen.queryByTestId("addon-hdr")).toBeNull();
  });

  it("without a plan: off by default, priced from the quote, and says plans include it", async () => {
    const quotes = captureQuotes();
    panel(project({ on: true, source: true }));
    const row = await screen.findByTestId("addon-hdr");
    const box = within(row).getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(row.textContent).toContain("HDR");
    expect(row.textContent).toContain(
      "Keeps the bright highlights and rich colour of your HDR video. Looks best on Apple Vision Pro.",
    );
    expect(row.textContent).toContain("Included with Pro, Business and Studio.");
    await waitFor(() => expect(quotes.some((q) => q.step === "production")).toBe(true));
    expect(quotes.some((q) => "hdr" in q)).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(quotes.some((q) => q.step === "production" && q.hdr === true)).toBe(true));
    await waitFor(() => expect(row.textContent).toMatch(/\+\$\d+\.\d\d/));
    expect((await screen.findByTestId("quote-hdr")).textContent).toMatch(/^\+\$/);
  });

  it("with Pro: Included, no plan nudge", async () => {
    mockDb.pro = true;
    panel(project({ on: true, source: true }));
    const row = await screen.findByTestId("addon-hdr");
    // the plan comes with the quote
    await waitFor(() => expect(row.textContent).not.toContain("Included with Pro, Business and Studio"));
    expect(row.textContent).toContain("Included");
    expect(row.textContent).not.toContain("+30%");
    expect((within(row).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(row).getByRole("checkbox"));
    await waitFor(() => expect(screen.getByTestId("quote-hdr").textContent).toBe("Included"));
  });
});

describe("HDR elsewhere", () => {
  const probe = { width: 3840, height: 2160, fps: 30, duration_s: 10 } as never;

  it("Overview names an HDR video only while HDR output is on", () => {
    expect(videoFacts({ probe, hdr_source: true })).not.toContain("HDR");
    expect(videoFacts({ probe, hdr_source: false, hdr_available: true })).not.toContain("HDR");
    expect(videoFacts({ probe, hdr_source: true, hdr_available: true })).toMatch(/· HDR video$/);
  });

  it("plan cards list HDR only when the gateway says it is included", () => {
    const def = { name: "Business", monthly_cents: 29900, credit_cents: 40000, max_active_runs: 3, free_previews_per_period: 50, express_included: true } as PlanDef;
    expect(planLines(def, 0.2)).not.toContain("HDR included");
    expect(planLines({ ...def, hdr_included: true }, 0.2)).toContain("HDR included");
  });

  it("the pricing page lists HDR only while it is on", async () => {
    mockDb.tierPricing = true;
    const { unmount } = render(
      <AuthProvider>
        <PricingScreen />
      </AuthProvider>,
    );
    await screen.findByTestId("pricing-addons");
    expect(document.body.textContent).not.toMatch(/HDR/);
    unmount();
    mockDb.hdrOutput = true;
    resetPricingCache();
    render(
      <AuthProvider>
        <PricingScreen />
      </AuthProvider>,
    );
    const addons = await screen.findByTestId("pricing-addons");
    await waitFor(() => expect(addons.textContent).toContain("HDR+30%"));
    await waitFor(() => expect(screen.getByTestId("plans").textContent).toContain("HDR included"));
  });

  it("the quote shows HDR as included on a plan", () => {
    render(
      <QuoteView
        result={{
          step: "production",
          method: "lifelike",
          params: { preset: "4k", formats: ["mvhevc"] },
          tier: "studio",
          quote: {
            amount_cents: 1600,
            currency: "usd",
            breakdown: { step: "production", preset: "4k", subtotal_cents: 2000, hdr: true, hdr_included: true, discount: null },
          },
          reuse_stages: null,
        }}
      />,
    );
    expect(screen.getByTestId("quote-hdr").textContent).toBe("Included");
  });

  it("Pro includes HDR only when the gateway says so", () => {
    expect(proIncludesHdr(null)).toBe(false);
    expect(proIncludesHdr({ addons: { hdr: { pct: 0.3, included_in: ["business", "studio"] } } } as never)).toBe(false);
    expect(proIncludesHdr({ addons: { hdr: { pct: 0.3, included_in: ["pro", "business"] } } } as never)).toBe(true);
    expect(proIncludesHdr({ pro_plans: [{ id: "pro_monthly", interval: "month", price_cents: 999, hdr_included: true }] } as never)).toBe(true);
  });

  it("the Pro page says HDR included only while it is on", async () => {
    const page = () =>
      render(
        <AuthProvider>
          <ProScreen />
        </AuthProvider>,
      );
    const first = page();
    await screen.findByTestId("pro-plans");
    expect(screen.queryByTestId("pro-hdr")).toBeNull();
    expect(document.body.textContent).not.toMatch(/HDR/);
    first.unmount();
    mockDb.hdrOutput = true;
    resetPricingCache();
    resetProForTests();
    page();
    expect((await screen.findByTestId("pro-hdr")).textContent).toBe("HDR included");
  });

  it("the Pro sheet says HDR included only while it is on", async () => {
    const sheet = async () => {
      const r = render(
        <AuthProvider>
          <ProSaveLink step="production" />
        </AuthProvider>,
      );
      fireEvent.click(await screen.findByTestId("pro-save-link"));
      return { r, el: await screen.findByTestId("pro-sheet") };
    };
    const off = await sheet();
    expect(off.el.textContent).not.toMatch(/HDR/);
    off.r.unmount();
    mockDb.hdrOutput = true;
    mockDb.tierPricing = true;
    resetPricingCache();
    const on = await sheet();
    expect(within(on.el).getByTestId("pro-sheet-hdr").textContent).toBe("HDR included");
  });
});
