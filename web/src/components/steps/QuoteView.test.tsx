/**
 * Regression: the Go gateway serializes a nil reuse_stages slice as null
 * (every non-production quote, and production quotes with no cache hit).
 * QuoteView must render the breakdown anyway — this crashed the whole app
 * from the Depth tab's "Get quote" button before the guard existed.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { StepQuoteResponse } from "@/lib/api/types";

import { QuoteView } from "./QuoteView";

function quoteResponse(
  reuseStages: StepQuoteResponse["reuse_stages"],
): StepQuoteResponse {
  return {
    step: "depth_preview",
    params: { preset: "draft", formats: ["anaglyph"] },
    quote: { amount_cents: 50, currency: "usd" },
    reuse_stages: reuseStages,
  };
}

describe("QuoteView reuse_stages guard", () => {
  afterEach(cleanup);

  it.each([null, undefined])(
    "renders without a reuse line when the gateway sends %s",
    (value) => {
      render(<QuoteView result={quoteResponse(value)} />);
      expect(screen.getByTestId("quote-total").textContent).toBe("$0.50");
      expect(screen.queryByTestId("quote-reuse-stages")).toBeNull();
    },
  );

  it("still renders the reuse line for a populated array", () => {
    render(<QuoteView result={quoteResponse(["depth", "preprocess"])} />);
    expect(screen.getByTestId("quote-reuse-stages").textContent).toContain(
      "depth",
    );
  });
});

describe("QuoteView in words (S3D-15/16/17/19)", () => {
  afterEach(cleanup);

  it("says the frame rate, the 10% off, the minimum and when it's charged", () => {
    render(
      <QuoteView
        result={{
          step: "production",
          params: { preset: "1080p", formats: ["sbs"] },
          quote: {
            amount_cents: 2531,
            currency: "usd",
            breakdown: {
              billable_seconds: 300,
              fps_factor: 1.25,
              base_cents: 2813,
              subtotal_cents: 2813,
              discount_cents: 282,
            },
          },
          charge_timing: "before",
        }}
      />,
    );
    expect(screen.getByText(/Your video: 5 min/).textContent).toBe(
      "Your video: 5 min at 30 fps (+25%)",
    );
    expect(screen.getByText("10% off runs over $10")).toBeTruthy();
    expect(screen.getByTestId("quote-bulk-discount").textContent).toBe("−$2.82");
    expect(screen.queryByTestId("quote-minimum")).toBeNull();
    expect(screen.getByTestId("quote-charge-timing").textContent).toBe(
      "Charged when it starts. Refunded if it fails.",
    );
  });

  it("names the $0.50 minimum per run when it applies (S3D-17)", () => {
    render(
      <QuoteView
        result={{
          step: "lifelike_preview",
          params: { preset: "1080p", formats: ["sbs"] },
          quote: {
            amount_cents: 50,
            currency: "usd",
            breakdown: { billable_seconds: 5, base_cents: 38, subtotal_cents: 38 },
          },
          charge_timing: "after",
        }}
      />,
    );
    expect(screen.getByTestId("quote-minimum").textContent).toBe("$0.50");
    expect(screen.getByText("Minimum charge $0.50")).toBeTruthy();
    expect(screen.getByTestId("quote-charge-timing").textContent).toBe(
      "Charged after it's done.",
    );
    // the grouping of small charges is internal (S3D-21)
    expect(document.body.textContent).not.toMatch(/balance|batch|pending/i);
  });
});

describe("QuoteView frame-rate cap (owner 2026-11-04)", () => {
  afterEach(cleanup);

  it("says a capped run converts at the capped rate, with billable minutes only", () => {
    render(
      <QuoteView
        result={{
          step: "production",
          method: "lifelike",
          params: { preset: "4k", formats: ["sbs"], target_fps: 30, fps_capped: true },
          quote: {
            amount_cents: 3750,
            currency: "usd",
            breakdown: {
              preset: "4k",
              billable_seconds: 149,
              billable_minutes: 3,
              cents_per_minute: 1000,
              fps_factor: 1.25,
              subtotal_cents: 3750,
            },
          },
          fps: {
            max_fps: 30,
            source_fps: 60,
            target_fps_choices: [30, 20, 15, 12, 10],
            fps_capped: true,
            reason: "plan_required_above_30fps",
            target_fps: 30,
          },
        }}
      />,
    );
    expect(screen.getByTestId("quote-fps-capped").textContent).toBe(
      "Converts at 30 fps. Higher frame rates come with Business and Studio plans.",
    );
    expect(screen.getByTestId("quote-breakdown").textContent).toContain("3 min at 4K");
    expect(screen.getByTestId("quote-breakdown").textContent).not.toContain("rounded up");
  });
});
