import type { JSX } from "react";

import type { QuoteBreakdown, StepQuoteResponse } from "@/lib/api/types";

import { formatCents } from "./money";

/** "~45s" under 90 s, "~3 min" (rounded) above — the quote's coarse
 * processing-time estimate. */
export function formatQuoteEta(seconds: number): string {
  if (seconds < 90) return `~${Math.round(seconds)}s`;
  return `~${Math.round(seconds / 60)} min`;
}

/**
 * Renders a step quote's breakdown as explicit line items. All amounts come
 * from the gateway in cents — no client-side price math beyond negating
 * discounts for display. When the gateway sends eta_seconds the estimated
 * processing time is shown as a clearly-labeled estimate.
 */
export function QuoteView({
  result,
}: {
  result: StepQuoteResponse;
}): JSX.Element {
  const b: QuoteBreakdown = result.quote.breakdown ?? {};
  const reuseStages = result.reuse_stages ?? [];
  const subtotal = b.subtotal_cents ?? result.quote.amount_cents;
  const minutes =
    b.billable_seconds !== undefined
      ? (b.billable_seconds / 60).toFixed(2)
      : null;
  // Adjustment lines between base and subtotal. Base is only worth a line
  // of its own when an adjustment actually moved it. The fps factor is
  // already inside base_cents (it scales the rate, not the subtotal), so it
  // annotates the rate hint rather than earning an adjustment line.
  const hasDepthFactor =
    b.depth_res_factor !== undefined && b.depth_res_factor !== 1;
  const hasInpaintMult =
    b.inpaint_multiplier !== undefined && b.inpaint_multiplier !== 1;
  const showBase =
    b.base_cents !== undefined &&
    b.base_cents !== subtotal &&
    (hasDepthFactor || hasInpaintMult);
  const fpsHint =
    b.fps_factor !== undefined && b.fps_factor !== 1 ? (
      <span data-testid="quote-fps-factor" className="ml-1 text-xs">
        × {b.fps_factor} fps
      </span>
    ) : null;
  const rateHint =
    minutes !== null && b.cents_per_minute !== undefined ? (
      <span className="ml-2 text-xs">
        {minutes} min × {formatCents(b.cents_per_minute)}/min
        {fpsHint}
      </span>
    ) : null;
  return (
    <dl
      data-testid="quote-breakdown"
      className="flex flex-col gap-1.5 rounded-lg border border-edge bg-surface-2 p-4 text-sm"
    >
      {showBase ? (
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-muted">Base{rateHint}</dt>
          <dd data-testid="quote-base" className="font-mono">
            {formatCents(b.base_cents!)}
          </dd>
        </div>
      ) : null}
      {hasDepthFactor ? (
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-muted">
            Depth resolution
            {b.depth_res !== undefined ? (
              <span className="ml-2 text-xs">{b.depth_res} px</span>
            ) : null}
          </dt>
          <dd data-testid="quote-depth-factor" className="font-mono">
            ×{b.depth_res_factor!.toFixed(2)}
          </dd>
        </div>
      ) : null}
      {hasInpaintMult ? (
        <div className="flex items-baseline justify-between gap-3">
          {/* >1: a preview paying for the fill pass; <1: a production
              render skipping it (Stretched edges) — user-facing names only */}
          <dt className="text-fg-muted">
            {b.inpaint_multiplier! > 1 ? "Full-quality edges" : "Stretched edges"}
          </dt>
          <dd data-testid="quote-inpaint-multiplier" className="font-mono">
            ×{b.inpaint_multiplier!.toFixed(1)}
          </dd>
        </div>
      ) : null}
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-fg-muted">
          Subtotal
          {showBase ? null : rateHint}
        </dt>
        <dd data-testid="quote-subtotal" className="font-mono">
          {formatCents(subtotal)}
        </dd>
      </div>
      {reuseStages.length > 0 ? (
        <div className="flex items-baseline justify-between gap-3">
          <dt className="flex flex-wrap items-center gap-1.5 text-fg-muted">
            Reusing:
            <span data-testid="quote-reuse-stages" className="flex gap-1">
              {reuseStages.map((stage) => (
                <span
                  key={stage}
                  className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-300"
                >
                  {stage}
                </span>
              ))}
            </span>
          </dt>
          <dd
            data-testid="quote-reuse-discount"
            className="font-mono text-emerald-300"
          >
            {formatCents(-(b.reuse_discount_cents ?? 0))}
          </dd>
        </div>
      ) : null}
      {(b.discount_cents ?? 0) > 0 ? (
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-muted">Bulk discount</dt>
          <dd
            data-testid="quote-bulk-discount"
            className="font-mono text-emerald-300"
          >
            {formatCents(-(b.discount_cents ?? 0))}
          </dd>
        </div>
      ) : null}
      {/* analyze_credit_cents is not rendered: analysis is free outright
          (the gateway's credit defaults to 0 since 2026-08-31) */}
      <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-edge pt-2">
        <dt className="font-medium">Total</dt>
        <dd
          data-testid="quote-total"
          className="font-mono text-base font-semibold"
        >
          {formatCents(result.quote.amount_cents)}
        </dd>
      </div>
      {result.eta_seconds !== undefined && result.eta_seconds > 0 ? (
        <div className="flex items-baseline justify-between gap-3 text-xs text-fg-muted">
          <dt>Estimated processing time (estimate only)</dt>
          <dd data-testid="quote-eta" className="font-mono">
            {formatQuoteEta(result.eta_seconds)}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
