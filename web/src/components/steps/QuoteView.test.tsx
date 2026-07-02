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
