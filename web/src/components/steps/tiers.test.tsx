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
import { expressHint, LifelikeDeliverPanel } from "./LifelikeDeliverPanel";
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
          { tier: "business", tier_label: "Business", discount: { kind: "tier", tier: "business", cents: 500, pct: 0.25 }, pro: true },
          { subtotal_cents: 2000, express: true, express_included: true, discount: { kind: "tier", tier: "business", cents: 500, pct: 0.25 } },
          1500,
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

  it("Express copy is honest about the saving", () => {
    expect(expressHint(undefined)).toBe("Faster: first in line.");
    expect(expressHint({ eta_seconds: 240, standard_eta_seconds: 300 })).toBe("First in line. About 1 min faster.");
    expect(expressHint({ eta_seconds: 600, standard_eta_seconds: 1200 })).toBe(
      "First in line. Up to about 2× faster on longer videos.",
    );
    expect(expressWaitLine(420)).toBe("Starting soon (Express). Within about 7 min.");
    expect(expressWaitLine()).toBe("Starting soon (Express).");
  });
});
