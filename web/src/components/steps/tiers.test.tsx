/**
 * Pricing 2026-11 (BL-19): the quote's one discount line (the tier's price
 * or 10% off over $50, never both), add-on lines and free previews.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { StepQuoteResponse } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { bulkLabel, QuoteView, tierPriceLabel } from "./QuoteView";

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
