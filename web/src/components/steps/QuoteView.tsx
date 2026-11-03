import type { JSX, ReactNode } from "react";

import type { QuoteBreakdown, StepQuoteResponse } from "@/lib/api/types";
import {
  CHARGED_AFTER,
  CHARGED_AT_START,
  quoteChargeSentence,
} from "@/lib/billingCopy";
import { formatDuration, formatVideoLength } from "@/lib/format";
import { qualityName } from "@/lib/glossary";

import { fpsLabel, quotedFps } from "./frameRate";
import { formatCents, formatCentsShort } from "./money";
import { proPercent, ProSaveLink } from "@/components/pricing/ProOffer";
import { usePricing } from "@/lib/api/usePricing";

const TIER_NAMES: Record<string, string> = { pro: "Pro", business: "Business", studio: "Studio" };

/** "Pro price", "Business price" (pricing 2026-11). */
export function tierPriceLabel(tier: string | undefined, label?: string): string {
  return `${label || TIER_NAMES[tier ?? ""] || "Your"} price`;
}

/** "+20%": an add-on's share of the list price, from the quote itself. */
function addonPct(cents: number, b: QuoteBreakdown): string {
  const base = b.list_base_cents ?? 0;
  return base > 0 ? `+${Math.round((cents / base) * 100)}%` : "add-on";
}

/** The bulk line with the threshold from /v1/pricing. */
function BulkLabel({ pct }: { pct: number }): JSX.Element {
  const threshold = usePricing()?.discount.threshold_cents ?? 5000;
  return <>{bulkLabel(pct, threshold)}</>;
}

/** "10% off over $50" from the gateway's bulk rule. */
export function bulkLabel(pct: number, thresholdCents: number): string {
  return `${Math.round(pct * 100)}% off over ${formatCentsShort(thresholdCents)}`;
}

/** The quote's processing-time estimate: "about 25 min" (lib/format). */
export { formatDuration as formatQuoteEta } from "@/lib/format";

/** What the customer is told about WHEN they pay, per charge_timing — the
 * short form beside the Convert button; the full sentence (with amounts)
 * sits under the quote (lib/billingCopy). */
export const CHARGE_BEFORE_COPY = CHARGED_AT_START;
export const CHARGE_AFTER_COPY = CHARGED_AFTER;

/** Classic's standard depth detail per quality — included in its
 * per-minute prices (mirrors the gateway's PresetInputSize). */
const STANDARD_DEPTH_DETAIL: Record<string, number> = {
  draft: 518,
  "1080p": 980,
  qhd: 1148,
  "3k": 1148,
  "4k": 1442,
};

/** The edge multiplier of each step's default (Filled edges). */
const DEFAULT_EDGE_MULTIPLIER: Record<string, number> = {
  stereo_preview: 1.6,
  production: 1,
};

/** Customer words for the stages a quote can reuse. */
const REUSE_NAMES: Record<string, string> = {
  depth: "depth work",
  preprocess: "preparation",
};

/** The length a quote charges for: the billable minutes ("3 min") when
 * the gateway rounds the video up to whole minutes (billable_minutes,
 * owner 2026-11-04; the rounding itself is said once, on Prices), else
 * the plain length (previews: "5 s"). */
export function billedLength(b: QuoteBreakdown): string {
  if (b.billable_minutes !== undefined) return `${b.billable_minutes} min`;
  return formatVideoLength(b.billable_seconds ?? 0);
}

/** What a run makes, for the pay sheet, the price card and the tracker:
 * "4K · 60 fps · 3 min" (owner 2026-11-04). */
export function runFacts(
  params: { preset?: string; target_fps?: number } | undefined,
  breakdown: QuoteBreakdown | undefined,
): string[] {
  const b = breakdown ?? {};
  const preset = params?.preset ?? b.preset;
  const fps = quotedFps(params, b.fps_factor);
  return [
    preset ? qualityName(preset) : null,
    fps !== null ? fpsLabel(fps) : null,
    b.billable_seconds !== undefined || b.billable_minutes !== undefined ? billedLength(b) : null,
  ].filter((x): x is string => x !== null);
}

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
 * charge $1" when the per-run floor applies (every run, S3D-17), the
 * total in USD excl. tax, and the sentence saying when it is charged. Classic's technical factors (depth
 * detail, edge handling) sit under "How we priced this". All amounts come
 * from the gateway — no client price math beyond negating discounts and
 * spotting the minimum.
 */
export function QuoteView({
  result,
  chargeLine = true,
  bare = false,
}: {
  result: StepQuoteResponse;
  /** false when the page says when it's charged beside its button */
  chargeLine?: boolean;
  /** no box around the lines (inside a price card) */
  bare?: boolean;
}): JSX.Element {
  const b: QuoteBreakdown = result.quote.breakdown ?? {};
  const total = result.quote.amount_cents;
  // pricing 2026-11: one discount line (the tier's price or bulk, never
  // both), add-ons on top of the list price, free previews
  const tierMode = result.discount !== undefined || "discount" in b;
  const discount = result.discount ?? ((b as Record<string, unknown>).discount as StepQuoteResponse["discount"]) ?? null;
  const addons = b.addons ?? {};
  const addonsTotal = tierMode
    ? Object.values(addons).reduce<number>((n, c) => n + (c ?? 0), 0)
    : (b.foveation_cents ?? 0);
  const freePreview = b.free_preview === true || result.payment_flow === "free_preview";
  const reuseStages = result.reuse_stages ?? [];
  const subtotal = b.subtotal_cents ?? total;
  const reuse = reuseStages.length > 0 ? (b.reuse_discount_cents ?? 0) : 0;
  const bulk = b.discount_cents ?? 0;
  // S3D-17: the per-run minimum (from the gateway) applies when the
  // total is above what the lines add up to
  // S3D-67: the quote's Pro line (full runs only)
  const proLine =
    result.pro_discount ??
    (b.pro_discount_cents ? { pct: b.pro_discount_pct ?? 0, cents: b.pro_discount_cents } : null);
  const proOff = proLine?.cents ?? 0;
  const minimumApplied =
    !freePreview &&
    b.subtotal_cents !== undefined &&
    total > subtotal - reuse - (tierMode ? (discount?.cents ?? 0) : bulk + proOff);

  // the rate the run converts at (the chosen one, or the source's)
  const fps = quotedFps(result.params, b.fps_factor);
  const videoLabel =
    b.billable_seconds !== undefined ? (
      <>
        Your video: {billedLength(b)}
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
  // S3D-12: Classic's per-minute prices include the standard depth detail
  // and Filled edges, so those factors fold into the video line; the factor
  // lines appear only when an Advanced setting changed them (the Depth
  // page always shows its own detail).
  const step = b.step ?? result.step;
  const standardDepth =
    b.preset !== undefined ? STANDARD_DEPTH_DETAIL[b.preset] : undefined;
  const depthChanged =
    hasDepthFactor &&
    (step === "depth_preview" ||
      standardDepth === undefined ||
      b.depth_res !== standardDepth);
  const edgeChanged =
    b.inpaint_multiplier !== undefined &&
    b.inpaint_multiplier !== (DEFAULT_EDGE_MULTIPLIER[step ?? ""] ?? 1);
  const technical = depthChanged || edgeChanged;

  // Lifelike (screens 06/07): "5 min 12 s at 4K · 5.2 min × $8.50 a
  // minute", then "Your video is 30 fps (+25%)" with what it adds
  const cpm =
    ((b as Record<string, unknown>).list_cents_per_minute as number | undefined) ?? b.cents_per_minute;
  const lifelikeLines =
    result.method === "lifelike" &&
    cpm !== undefined &&
    b.billable_seconds !== undefined &&
    b.fps_factor !== undefined;
  const fovCents = addonsTotal;
  const minutes = b.billable_minutes ?? (b.billable_seconds ?? 0) / 60;
  const atRate = lifelikeLines ? Math.round(minutes * cpm!) : 0;
  const fpsAdds = lifelikeLines ? subtotal - fovCents - atRate : 0;

  return (
    <div
      data-testid="quote-breakdown"
      className={`flex flex-col gap-1.5 text-sm ${
        bare ? "" : "rounded-lg border border-edge bg-surface-2 p-4"
      }`}
    >
      {lifelikeLines ? (
        <>
          <Line
            label={
              <>
                {billedLength(b)}
                {b.preset ? ` at ${qualityName(b.preset)}` : ""}
                <span className="block text-[11px] text-fg-muted/80">
                  {b.billable_minutes ?? minutes.toFixed(1)} min × {formatCents(cpm!)} a minute
                </span>
              </>
            }
            value={formatCents(atRate)}
            testId="quote-base"
          />
          {b.fps_factor !== 1 && fps !== null ? (
            <Line
              label={
                <span data-testid="quote-fps-factor">
                  At {fpsLabel(fps)} ({percent(b.fps_factor!)})
                </span>
              }
              value={`${fpsAdds >= 0 ? "+" : "−"}${formatCents(Math.abs(fpsAdds))}`}
            />
          ) : null}
        </>
      ) : (
        <Line
          label={videoLabel}
          value={formatCents(
            (technical ? (b.base_cents ?? subtotal) : subtotal) - fovCents,
          )}
          testId="quote-base"
        />
      )}
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
                label="Edge style"
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
      {b.foveation_factor !== undefined && b.foveation_factor !== 1 ? (
        <Line
          label={`Foveated Detail (${percent(b.foveation_factor)})`}
          value={
            b.foveation_cents !== undefined
              ? `+${formatCents(b.foveation_cents)}`
              : percent(b.foveation_factor)
          }
          testId="quote-foveation"
        />
      ) : null}
      {addons.master ? (
        <Line
          label={`Master bitrate (${addonPct(addons.master, b)})`}
          value={`+${formatCents(addons.master)}`}
          testId="quote-master"
        />
      ) : null}
      {addons.express ? (
        <Line
          label={`Express (${addonPct(addons.express, b)})`}
          value={`+${formatCents(addons.express)}`}
          testId="quote-express"
        />
      ) : (b as Record<string, unknown>).express_included === true ? (
        <Line label="Express" value="Included" testId="quote-express" />
      ) : null}
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
      {tierMode && discount && discount.cents > 0 ? (
        <Line
          label={
            discount.kind === "tier"
              ? tierPriceLabel(discount.tier, result.tier_label)
              : <BulkLabel pct={discount.pct} />
          }
          value={formatCents(-discount.cents)}
          testId={discount.kind === "tier" ? "quote-tier" : "quote-bulk-discount"}
          tone="discount"
        />
      ) : null}
      {freePreview ? (
        <Line
          label={result.free_previews?.intro ? "Your first preview is free" : "Free preview"}
          value={
            typeof (b as Record<string, unknown>).price_without_free_cents === "number"
              ? formatCents(-((b as Record<string, unknown>).price_without_free_cents as number))
              : "Free"
          }
          testId="quote-free-preview"
          tone="discount"
        />
      ) : null}
      {!tierMode && bulk > 0 ? (
        <Line
          label="10% off runs over $10"
          value={formatCents(-bulk)}
          testId="quote-bulk-discount"
          tone="discount"
        />
      ) : null}
      {!tierMode && proLine && proOff > 0 ? (
        // S3D-67: one compact line for members
        <Line
          label={`Pro −${proPercent(proLine.pct)}%`}
          value={formatCents(-proOff)}
          testId="quote-pro"
          tone="discount"
        />
      ) : null}
      {minimumApplied ? (
        <Line
          label={`Minimum charge ${formatCentsShort(total)}`}
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
      {(result.fps?.fps_capped || result.params?.fps_capped) && fps !== null ? (
        // owner 2026-11-04: the source is above 30 fps and there's no plan
        <p data-testid="quote-fps-capped" className="text-xs text-fg-muted">
          Converts at {fpsLabel(fps)}. Higher frame rates come with Business
          and Studio plans.
        </p>
      ) : null}
      {/* no Pro upsell on a plan's quote (Business and Studio include Pro) */}
      {result.pro === false && !(result.tier === "business" || result.tier === "studio") ? (
        <ProSaveLink step={result.step} />
      ) : null}
      {chargeLine ? (
        <p data-testid="quote-charge-timing" className="text-xs text-fg">
          {quoteChargeSentence(result.charge_timing)}
        </p>
      ) : null}
      {result.eta_seconds !== undefined && result.eta_seconds > 0 ? (
        <div className="flex items-baseline justify-between gap-3 text-xs text-fg-muted">
          <span>{chargeLine ? "Estimated time" : "Ready in"}</span>
          <span data-testid="quote-eta">{formatDuration(result.eta_seconds)}</span>
        </div>
      ) : null}
    </div>
  );
}
