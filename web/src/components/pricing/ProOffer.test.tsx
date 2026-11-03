/**
 * S3D-67: the Pro discount on a quote — one compact line for members, one
 * quiet link (and its small sheet) for everyone else, nothing when the
 * gateway says nothing.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { QuoteView } from "@/components/steps/QuoteView";
import type { StepQuoteResponse } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  resetPricingCache();
});
afterAll(() => server.close());

function quote(pro: boolean | undefined): StepQuoteResponse {
  return {
    step: "production",
    method: "lifelike",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: {
      amount_cents: pro ? 1360 : 1700,
      currency: "usd",
      breakdown: {
        preset: "4k",
        billable_seconds: 120,
        cents_per_minute: 850,
        fps_factor: 1,
        subtotal_cents: 1700,
        ...(pro ? { pro_discount_pct: 0.2, pro_discount_cents: 340 } : {}),
      },
    },
    ...(pro !== undefined ? { pro } : {}),
    ...(pro ? { pro_discount: { pct: 0.2, cents: 340 } } : {}),
  };
}

describe("Pro discount (S3D-67)", () => {
  it("a member's quote has one compact Pro line and no offer", () => {
    render(<AuthProvider><QuoteView result={quote(true)} /></AuthProvider>);
    expect(screen.getByText("Pro −20%")).toBeTruthy();
    expect(screen.getByTestId("quote-pro").textContent).toBe("−$3.40");
    expect(screen.getByTestId("quote-total").textContent).toBe("$13.60");
    expect(screen.queryByTestId("quote-minimum")).toBeNull();
    expect(screen.queryByTestId("pro-save-link")).toBeNull();
  });

  it("a non-member sees one quiet link that opens the Pro sheet", async () => {
    render(<AuthProvider><QuoteView result={quote(false)} /></AuthProvider>);
    const link = await screen.findByTestId("pro-save-link");
    expect(link.textContent).toBe("Pro members save 20%");
    expect(screen.queryByTestId("quote-pro")).toBeNull();
    fireEvent.click(link);
    const sheet = await screen.findByTestId("pro-sheet");
    expect(within(sheet).getByText("20% off every 3D video")).toBeTruthy();
    expect(within(sheet).getByRole("link", { name: "Get Pro" }).getAttribute("href")).toBe("/pro");
  });

  it("a preview is never discounted: no link on it", async () => {
    render(<AuthProvider><QuoteView result={{ ...quote(false), step: "lifelike_preview" }} /></AuthProvider>);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("pro-save-link")).toBeNull();
  });

  it("says nothing about Pro when the gateway doesn't", async () => {
    render(<AuthProvider><QuoteView result={quote(undefined)} /></AuthProvider>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("pro-save-link")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Pro/);
  });
});
