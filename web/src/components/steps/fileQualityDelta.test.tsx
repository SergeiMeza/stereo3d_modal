/**
 * BUX-14: File quality says what High and Master add to this video in
 * dollars beside their share, from the quote the page has: exact on the
 * list price, "about" when a discount scales it, nothing when the quote
 * can't say.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { PublicPricing, StepQuoteResponse } from "@/lib/api/types";

import { FileQualityScale, qualityDelta } from "./FileQuality";

const pricing = {
  minimum_cents: 50,
  preview_minimum_cents: 50,
  quality: {
    tiers: ["standard", "high", "master"],
    high: { price_pct: 0.3 },
    master: { price_pct: 0.5 },
  },
} as unknown as PublicPricing;

function quote(extra: Partial<StepQuoteResponse> = {}, bd: Record<string, unknown> = {}): StepQuoteResponse {
  return {
    step: "production",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: { amount_cents: 1200, currency: "usd", breakdown: { list_base_cents: 1200, ...bd } },
    ...extra,
  };
}

afterEach(cleanup);

describe("qualityDelta (BUX-14)", () => {
  it("list price, no discount: exact, the gateway's share of the list base", () => {
    expect(qualityDelta(quote(), pricing, "high")).toEqual({ cents: 360, approx: false });
    expect(qualityDelta(quote(), pricing, "master")).toEqual({ cents: 600, approx: false });
    expect(qualityDelta(quote(), pricing, "standard")).toBeNull();
  });

  it("the chosen step reads its own add-on line", () => {
    expect(qualityDelta(quote({}, { addons: { high: 361 } }), pricing, "high")).toEqual({ cents: 361, approx: false });
  });

  it("a plan discount or the launch offer: about, scaled by each", () => {
    const d = qualityDelta(quote({ discount: { kind: "tier", tier: "pro", cents: 180, pct: 0.15 } }, { campaign_pct: 0.25 }), pricing, "high");
    expect(d).toEqual({ cents: Math.round(360 * 0.85 * 0.75), approx: true });
  });

  it("can't say: no list base, a free preview, or a total at the floor", () => {
    const noBase = quote();
    delete (noBase.quote.breakdown as Record<string, unknown>).list_base_cents;
    expect(qualityDelta(noBase, pricing, "high")).toBeNull();
    expect(qualityDelta(quote({ payment_flow: "free_preview" }), pricing, "high")).toBeNull();
    expect(qualityDelta(quote({ quote: { amount_cents: 50, currency: "usd", breakdown: { list_base_cents: 40 } } }), pricing, "high")).toBeNull();
    expect(qualityDelta(null, pricing, "high")).toBeNull();
  });
});

describe("File quality scale shows it (BUX-14)", () => {
  it("+30% · +$3.60 and +50% · +$6.00; Standard has neither", () => {
    render(<FileQualityScale value="standard" onChange={() => {}} pricing={pricing} quote={quote()} />);
    expect(screen.getByTestId("file-quality-high-price").textContent).toBe("+30%· +$3.60");
    expect(screen.getByTestId("file-quality-master-price").textContent).toBe("+50%· +$6.00");
    expect(screen.queryByTestId("file-quality-standard-price")).toBeNull();
  });

  it("with a discount it says about", () => {
    render(
      <FileQualityScale
        value="standard"
        onChange={() => {}}
        pricing={pricing}
        quote={quote({ discount: { kind: "bulk", cents: 120, pct: 0.1 } })}
      />,
    );
    expect(screen.getByTestId("file-quality-high-delta").textContent).toBe("· about +$3.24");
  });

  it("without a quote, only the share", () => {
    render(<FileQualityScale value="standard" onChange={() => {}} pricing={pricing} />);
    expect(screen.getByTestId("file-quality-high-price").textContent).toBe("+30%");
  });
});
