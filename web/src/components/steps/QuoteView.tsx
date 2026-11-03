import type { JSX, ReactNode } from "react";

import type { QuoteBreakdown, StepQuoteResponse } from "@/lib/api/types";
import { quoteChargeSentence } from "@/lib/billingCopy";
import { formatDuration, formatVideoLength } from "@/lib/format";

import { formatCents } from "./money";

/** The quote's processing-time estimate: "about 25 min" (lib/format). */
export { formatDuration as formatQuoteEta } from "@/lib/format";

/** What the customer is told about WHEN they pay, per charge_timing — the
 * short form beside the Convert button; the full sentence (with amounts)
 * sits under the quote (lib/billingCopy). */
export const CHARGE_BEFORE_COPY =
  "Paid when the run starts. Refunded in full if it fails.";
export const CHARGE_AFTER_COPY =
  "Added to your balance after it succeeds.";

/** Customer words for the stages a quote can reuse. */
const REUSE_NAMES: Record<string, string> = {
  depth: "depth work",
  preprocess: "preparation",
};

/** "+25%" / "−50%" for a price factor. */
function percent(factor: number): string {
  const p = Math.round((factor - 1) * 100);
  return p >= 0 ? `+${p}%` : `−${-p}%`;
}

function Line({
  label,
  value,
  testId,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  testId?: string;
  tone?: "discount";
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-fg-muted">{label}</span>
      <span
        data-testid={testId}
        className={`font-mono ${tone === "discount" ? "text-emerald-300" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * A step quote in words (S3D-15/16/17/19): the video's length and frame
 * rate (+25% at 30 fps), reused work, "10% off runs over $10", "Minimum
 * charge $0.50" when the per-run floor applies (previews included), the
 * total in USD excl. tax, and the sentence saying when it is charged. Classic's technical factors (depth
 * detail, edge handling) sit under "How we priced this". All amounts come
 * from the gateway — no client price math beyond negating discounts and
 * spotting the minimum.
 */
export function QuoteView({
  result,
  balanceLimitCents,
}: {
  result: StepQuoteResponse;
  /** the account's balance limit, for the "charged within 4 hours or when
   * it reaches $X" sentence */
  balanceLimitCents?: number;
}): JSX.Element {
  const b: QuoteBreakdown = result.quote.breakdown ?? {};
  const total = result.quote.amount_cents;
  const reuseStages = result.reuse_stages ?? [];
  const subtotal = b.subtotal_cents ?? total;
  const reuse = reuseStages.length > 0 ? (b.reuse_discount_cents ?? 0) : 0;
  const bulk = b.discount_cents ?? 0;
  // S3D-17: the $0.50 minimum per run (previews included) applies when the
  // total is above what the lines add up to
  const minimumApplied =
    b.subtotal_cents !== undefined && total > subtotal - reuse - bulk;

  const fps =
    b.fps_factor !== undefined ? Math.round(b.fps_factor * 24 * 100) / 100 : null;
  const videoLabel =
    b.billable_seconds !== undefined ? (
      <>
        Your video: {formatVideoLength(b.billable_seconds)}
        {fps !== null && b.fps_factor !== 1 ? (
          <span data-testid="quote-fps-factor">
            {" "}
            at {fps} fps ({percent(b.fps_factor!)})
          </span>
        ) : null}
      </>
    ) : (
      "Price"
    );

  const hasDepthFactor =
    b.depth_res_factor !== undefined && b.depth_res_factor !== 1;
  const hasInpaintMult =
    b.inpaint_multiplier !== undefined && b.inpaint_multiplier !== 1;
  const technical = hasDepthFactor || hasInpaintMult;

  return (
    <div
      data-testid="quote-breakdown"
      className="flex flex-col gap-1.5 rounded-lg border border-edge bg-surface-2 p-4 text-sm"
    >
      <Line
        label={videoLabel}
        value={formatCents(b.base_cents ?? subtotal)}
        testId="quote-base"
      />
      {technical ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-fg-muted">
            How we priced this
          </summary>
          <div className="mt-1.5 flex flex-col gap-1 pl-3">
            {hasDepthFactor ? (
              <Line
                label={
                  <>
                    Depth detail
                    {b.depth_res !== undefined ? ` (${b.depth_res} px)` : ""}
                  </>
                }
                value={percent(b.depth_res_factor!)}
                testId="quote-depth-factor"
              />
            ) : null}
            {hasInpaintMult ? (
              <Line
                label="Edge handling"
                value={percent(b.inpaint_multiplier!)}
                testId="quote-inpaint-multiplier"
              />
            ) : null}
          </div>
        </details>
      ) : null}
      {technical ? (
        <Line label="Subtotal" value={formatCents(subtotal)} testId="quote-subtotal" />
      ) : (
        <span data-testid="quote-subtotal" hidden>
          {formatCents(subtotal)}
        </span>
      )}
      {reuseStages.length > 0 ? (
        <Line
          label={
            <>
              Reusing your earlier{" "}
              <span data-testid="quote-reuse-stages">
                {reuseStages.map((s) => REUSE_NAMES[s] ?? s).join(" and ")}
              </span>
            </>
          }
          value={formatCents(-reuse)}
          testId="quote-reuse-discount"
          tone="discount"
        />
      ) : null}
      {bulk > 0 ? (
        <Line
          label="10% off runs over $10"
          value={formatCents(-bulk)}
          testId="quote-bulk-discount"
          tone="discount"
        />
      ) : null}
      {minimumApplied ? (
        <Line
          label={`Minimum charge ${formatCents(total)}`}
          value={formatCents(total)}
          testId="quote-minimum"
        />
      ) : null}
      <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-edge pt-2">
        <span className="font-medium">
          Total{" "}
          <span className="text-xs font-normal text-fg-muted">USD, excl. tax</span>
        </span>
        <span
          data-testid="quote-total"
          className="font-mono text-base font-semibold"
        >
          {formatCents(total)}
        </span>
      </div>
      <p data-testid="quote-charge-timing" className="text-xs text-fg">
        {quoteChargeSentence(total, result.charge_timing, balanceLimitCents)}
      </p>
      {result.eta_seconds !== undefined && result.eta_seconds > 0 ? (
        <div className="flex items-baseline justify-between gap-3 text-xs text-fg-muted">
          <span>Estimated time</span>
          <span data-testid="quote-eta">{formatDuration(result.eta_seconds)}</span>
        </div>
      ) : null}
    </div>
  );
}
