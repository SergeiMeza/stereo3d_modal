/**
 * Pricing 2026-11 (BL-19): the quote's one discount line (the tier's price
 * or 10% off over $50, never both), add-on lines and free previews.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { StepQuoteResponse } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { expressWaitLine } from "./ConversionTracker";
import { EXPRESS_HINT, LifelikeDeliverPanel } from "./LifelikeDeliverPanel";
import { LifelikePreviewPanel } from "./LifelikePreviewPanel";
import { freePreviewText } from "./useStepCheckout";
import { bulkLabel, QuoteView, tierPriceLabel } from "./QuoteView";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 30 }));

const PID = (projectFixture as { project_id: string }).project_id;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function lifelike(over: Partial<StepQuoteResponse>, breakdown: Record<string, unknown>, amount: number): StepQuoteResponse {
  return {
    step: "production",
    method: "lifelike",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: {
      amount_cents: amount,
      currency: "usd",
      breakdown: {
        step: "production",
        preset: "4k",
        billable_seconds: 120,
        fps_factor: 1,
        list_cents_per_minute: 1000,
        cents_per_minute: 850,
        list_base_cents: 2000,
        ...breakdown,
      },
    },
    reuse_stages: null,
    ...over,
  };
}

describe("tier pricing on the quote", () => {
  it("labels", () => {
    expect(tierPriceLabel("business")).toBe("Business price");
    expect(tierPriceLabel("pro", "Pro")).toBe("Pro price");
    expect(bulkLabel(0.1, 5000)).toBe("10% off over $50");
  });

  it("Pro: list price, Master bitrate, then one Pro price line", () => {
    render(
      <QuoteView
        result={lifelike(
          { tier: "pro", tier_label: "Pro", discount: { kind: "tier", tier: "pro", cents: 360, pct: 0.15 }, pro: true },
          { addons: { master: 400 }, subtotal_cents: 2400, discount: { kind: "tier", tier: "pro", cents: 360, pct: 0.15 } },
          2040,
        )}
      />,
    );
    expect(screen.getByTestId("quote-base").textContent).toBe("$20.00");
    expect(screen.getByTestId("quote-master").textContent).toBe("+$4.00");
    expect(screen.getByText("Master bitrate (+20%)")).toBeTruthy();
    expect(screen.getByText("Pro price")).toBeTruthy();
    expect(screen.getByTestId("quote-tier").textContent).toBe("−$3.60");
    expect(screen.queryByTestId("quote-bulk-discount")).toBeNull();
    expect(screen.queryByTestId("quote-minimum")).toBeNull();
    expect(screen.getByTestId("quote-total").textContent).toBe("$20.40");
  });

  it("bulk instead of a tier: 10% off over $50", async () => {
    render(
      <AuthProvider>
        <QuoteView
          result={lifelike(
            { tier: "", discount: { kind: "bulk", cents: 600, pct: 0.1 }, pro: false },
            { list_base_cents: 6000, billable_seconds: 360, subtotal_cents: 6000, discount: { kind: "bulk", cents: 600, pct: 0.1 } },
            5400,
          )}
        />
      </AuthProvider>,
    );
    expect(await screen.findByText("10% off over $50")).toBeTruthy();
    expect(screen.getByTestId("quote-bulk-discount").textContent).toBe("−$6.00");
    expect(screen.queryByTestId("quote-tier")).toBeNull();
  });

  it("Business: Express included", () => {
    render(
      <QuoteView
        result={lifelike(
          { tier: "business", tier_label: "Business", discount: { kind: "tier", tier: "business", cents: 400, pct: 0.2 }, pro: true },
          { subtotal_cents: 2000, express: true, express_included: true, discount: { kind: "tier", tier: "business", cents: 400, pct: 0.2 } },
          1600,
        )}
      />,
    );
    expect(screen.getByTestId("quote-express").textContent).toBe("Included");
    expect(screen.getByText("Business price")).toBeTruthy();
  });

  it("a free preview: total $0.00", () => {
    render(
      <QuoteView
        result={{
          step: "lifelike_preview",
          method: "lifelike",
          params: { preset: "4k", formats: ["sbs"] },
          payment_flow: "free_preview",
          free_previews: { allowance: 1, used: 0, remaining: 1, daily_left: 20, units: 1, free: true, intro: true },
          quote: {
            amount_cents: 0,
            currency: "usd",
            breakdown: { step: "lifelike_preview", subtotal_cents: 100, addons: {}, discount: null, free_preview: true, price_without_free_cents: 100 },
          },
          reuse_stages: null,
        }}
      />,
    );
    expect(screen.getByText("Your first preview is free")).toBeTruthy();
    expect(screen.getByTestId("quote-total").textContent).toBe("$0.00");
    expect(screen.queryByTestId("quote-minimum")).toBeNull();
  });
});

describe("add-ons in Make 3D (pricing 2026-11)", () => {
  function deliver() {
    const p = mockDb.projects.get(PID)!;
    p.method = "lifelike";
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
  beforeEach(() => {
    mockDb.tierPricing = true;
    resetPricingCache();
  });
  afterEach(() => {
    server.events.removeAllListeners();
    act(() => clearStepQuotes());
    resetPricingCache();
  });

  it("Master bitrate and Express add to the price and the request", async () => {
    const quotes = captureQuotes();
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={deliver()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const masterRow = await screen.findByTestId("addon-master");
    expect(masterRow.textContent).toContain("+20%");
    const expressRow = screen.getByTestId("addon-express");
    expect(expressRow.textContent).toContain("+50%");
    fireEvent.click(within(masterRow).getByRole("checkbox"));
    fireEvent.click(within(expressRow).getByRole("checkbox"));
    await waitFor(() =>
      expect(quotes.some((q) => q.step === "production" && q.bitrate === "master" && q.express === true)).toBe(true),
    );
    expect(await screen.findByTestId("quote-master")).toBeTruthy();
    expect(screen.getByTestId("quote-express")).toBeTruthy();
    expect((document.getElementById("make-bitrate") as HTMLSelectElement).disabled).toBe(true);
  });

  it("Business: Express included and ticked", async () => {
    mockDb.billing.plan = {
      plan: "business", name: "Business", status: "active", active: true, monthly_cents: 29900,
      credit_cents: 40000, credit_left_cents: 40000, cancel_at_period_end: false,
    };
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={deliver()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const row = await screen.findByTestId("addon-express");
    await waitFor(() => expect(row.textContent).toContain("Included"));
    expect((within(row).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByText("Business price")).toBeTruthy();
  });

  it("Express copy says first in line and promises no time saved (owner 2026-11-07)", () => {
    expect(EXPRESS_HINT).toBe("First in line.");
    expect(expressWaitLine(420)).toBe("Starting soon (Express). Within about 7 min.");
    expect(expressWaitLine()).toBe("Starting soon (Express).");
  });
});

describe("free previews (pricing 2026-11)", () => {
  function preview() {
    const p = mockDb.projects.get(PID)!;
    p.method = "lifelike";
    return structuredClone({ ...p, conversions: [] });
  }
  beforeEach(() => {
    mockDb.tierPricing = true;
    resetPricingCache();
  });
  afterEach(() => {
    act(() => clearStepQuotes());
    resetPricingCache();
  });

  it("a new account's first preview is free and starts without paying", async () => {
    render(
      <AuthProvider>
        <LifelikePreviewPanel project={preview()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    expect((await screen.findByTestId("free-previews")).textContent).toBe("Your first preview is free");
    await waitFor(() => expect(screen.getByTestId("checkout-main").textContent).toBe("Preview this moment · Free"));
    expect(screen.getByTestId("charge-timing-hint").textContent).toBe("Free preview");
    fireEvent.click(screen.getByTestId("checkout-main"));
    await waitFor(() => expect(mockDb.conversions.size).toBe(1));
    expect([...mockDb.conversions.values()][0].billing?.status).toBe("free_preview");
    expect(screen.queryByTestId("pay-sheet")).toBeNull();
    expect(mockDb.freePreviews.introUsed).toBe(true);
  });

  it("Pro: what's left this month", async () => {
    mockDb.pro = true;
    mockDb.freePreviews.used = 17;
    render(
      <AuthProvider>
        <LifelikePreviewPanel project={preview()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    expect((await screen.findByTestId("free-previews")).textContent).toBe("3 of 20 free previews left this month");
  });

  it("texts follow the quote's period (00083)", () => {
    const base = { allowance: 20, used: 20, remaining: 0, daily_left: 20, units: 1, free: false, intro: false };
    expect(freePreviewText({ ...base, period: "month" })).toBe("0 of 20 free previews left this month");
    expect(freePreviewText({ ...base, allowance: 5, remaining: 2, period: "week" })).toBe("2 of 5 free previews left this week");
    expect(freePreviewText({ ...base, allowance: 240, remaining: 200, period: "year" })).toBe("200 of 240 free previews left this year");
    expect(freePreviewText({ ...base, allowance: 60, remaining: 41, period: "pass" })).toBe("41 of 60 free previews left on your pass");
    expect(freePreviewText({ ...base, allowance: 1, remaining: 1, free: true, intro: true, period: "first_project" })).toBe(
      "Your first preview is free",
    );
    expect(freePreviewText({ ...base, allowance: 1, intro: true, period: "first_project" })).toBeNull();
    // no period: no guessed month
    expect(freePreviewText({ ...base, remaining: 3 })).toBe("3 of 20 free previews left");
    expect(freePreviewText({ ...base, remaining: 5, daily_left: 0, period: "month" })).toBe("Today's free previews are used. More tomorrow.");
  });
});

describe("preview downloads (owner: previews go to a headset by AirDrop)", () => {
  afterEach(() => act(() => clearStepQuotes()));

  it("each preview format downloads under its _preview_ name; a play is logged", async () => {
    const run = {
      conversion_id: "cprev0000001",
      state: "succeeded" as const,
      kind: "video" as const,
      project_id: PID,
      step: "lifelike_preview" as const,
      method: "lifelike" as const,
      params: { preset: "1080p" as const, formats: ["sbs", "mvhevc"] as ("sbs" | "mvhevc")[], from_frame: 0, to_frame: 120 },
      quote: { amount_cents: 0, currency: "usd" },
      progress: 1,
      outputs: ["sbs", "mvhevc"],
      billing: { status: "free_preview" as const },
      created_at: "2026-11-03T00:00:00Z",
      updated_at: "2026-11-03T00:00:00Z",
    };
    mockDb.conversions.set(run.conversion_id, run);
    const p = mockDb.projects.get(PID)!;
    p.method = "lifelike";
    render(
      <AuthProvider>
        <LifelikePreviewPanel project={structuredClone({ ...p, conversions: [run] })} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const links = await screen.findByTestId("preview-downloads");
    const mov = within(links).getByTestId("preview-download-mvhevc");
    const mp4 = within(links).getByTestId("preview-download-sbs");
    expect(mov.textContent).toBe("Vision Pro · .mov");
    expect(mp4.textContent).toBe("Side by side · .mp4");
    expect(mov.getAttribute("title")).toMatch(/_1080p_preview_.+\.mov$/);
    expect(mov.hasAttribute("download")).toBe(true);
    // the side-by-side plays in the 3D check: one play logged
    const video = await screen.findByTestId("lifelike-preview-video");
    fireEvent.play(video);
    fireEvent.play(video);
    await waitFor(() => expect(mockDb.plays).toEqual([{ conversion_id: "cprev0000001", file: "sbs", kind: "preview" }]));
  });
});
