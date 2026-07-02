import type { JSX } from "react";

import type { QuoteBreakdown, StepQuoteResponse } from "@/lib/api/types";

import { formatCents } from "./money";

/**
 * Renders a step quote's breakdown as explicit line items. All amounts come
 * from the gateway in cents — no client-side price math beyond negating
 * discounts for display.
 */
export function QuoteView({
  result,
}: {
  result: StepQuoteResponse;
}): JSX.Element {
  const b: QuoteBreakdown = result.quote.breakdown ?? {};
  const subtotal = b.subtotal_cents ?? result.quote.amount_cents;
  const minutes =
    b.billable_seconds !== undefined
      ? (b.billable_seconds / 60).toFixed(2)
      : null;
  // Adjustment lines between base and subtotal. Base is only worth a line
  // of its own when an adjustment actually moved it.
  const hasDepthFactor =
    b.depth_res_factor !== undefined && b.depth_res_factor !== 1;
  const hasInpaintMult =
    b.inpaint_multiplier !== undefined && b.inpaint_multiplier !== 1;
  const showBase =
    b.base_cents !== undefined &&
    b.base_cents !== subtotal &&
    (hasDepthFactor || hasInpaintMult);
  const rateHint =
    minutes !== null && b.cents_per_minute !== undefined ? (
      <span className="ml-2 text-xs">
        {minutes} min × {formatCents(b.cents_per_minute)}/min
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
          <dt className="text-fg-muted">Inpainting (ProPainter)</dt>
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
      {result.reuse_stages.length > 0 ? (
        <div className="flex items-baseline justify-between gap-3">
          <dt className="flex flex-wrap items-center gap-1.5 text-fg-muted">
            Reusing:
            <span data-testid="quote-reuse-stages" className="flex gap-1">
              {result.reuse_stages.map((stage) => (
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
      {(b.analyze_credit_cents ?? 0) > 0 ? (
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-muted">Analyze credit</dt>
          <dd
            data-testid="quote-analyze-credit"
            className="font-mono text-emerald-300"
          >
            {formatCents(-(b.analyze_credit_cents ?? 0))}
          </dd>
        </div>
      ) : null}
      <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-edge pt-2">
        <dt className="font-medium">Total</dt>
        <dd
          data-testid="quote-total"
          className="font-mono text-base font-semibold"
        >
          {formatCents(result.quote.amount_cents)}
        </dd>
      </div>
    </dl>
  );
}
