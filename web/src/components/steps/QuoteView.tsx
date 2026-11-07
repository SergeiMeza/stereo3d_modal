import type { JSX, ReactNode } from "react";

import type { QuoteBreakdown, StepQuoteResponse } from "@/lib/api/types";
import {
  CHARGED_AFTER,
  CHARGED_AT_START,
  chargedAfter,
  chargedAtStart,
  quoteChargeSentence,
} from "@/lib/billingCopy";
import { formatDuration, formatVideoLength } from "@/lib/format";
import { qualityName } from "@/lib/glossary";

import { fpsLabel, quotedFps } from "./frameRate";
import { formatCents, formatCentsShort } from "./money";
import { proPercent, ProSaveLink } from "@/components/pricing/ProOffer";
import { usePricing } from "@/lib/api/usePricing";
import { foveatedDetail, foveationIncludedApplied } from "@/lib/foveation";
import { useT } from "@/lib/i18n/I18nProvider";
import { rich } from "@/lib/i18n/rich";
import { EN, type Tr } from "@/lib/i18n/t";
import { offerLabel } from "@/lib/campaign";

const TIER_NAMES: Record<string, string> = { pro: "Pro", business: "Business", studio: "Studio" };

/** "Pro price", "Business price" (pricing 2026-11). */
export function tierPriceLabel(tier: string | undefined, label?: string, t: Tr = EN): string {
  const name = label || TIER_NAMES[tier ?? ""];
  return name ? t("quote.view.tierPrice", { name }) : t("quote.view.yourPrice");
}

/** "+20%": an add-on's share of the list price, from the quote itself. */
function addonPct(cents: number, b: QuoteBreakdown, t: Tr): string {
  const base = b.list_base_cents ?? 0;
  return base > 0 ? `+${Math.round((cents / base) * 100)}%` : t("quote.view.addOn");
}

/** The bulk line with the threshold from /v1/pricing. */
function BulkLabel({ pct }: { pct: number }): JSX.Element {
  const t = useT();
  const threshold = usePricing()?.discount.threshold_cents ?? 5000;
  return <>{bulkLabel(pct, threshold, t)}</>;
}

/** The older quotes' bulk line: the share and threshold from /v1/pricing
 * (never a fixed "10% off runs over $10"). */
function PricingBulkLabel(): JSX.Element {
  const t = useT();
  const d = usePricing()?.discount;
  return d ? <>{bulkLabel(d.pct, d.threshold_cents, t)}</> : <>{t("quote.view.bulkDiscount")}</>;
}

/** "10% off over $50" from the gateway's bulk rule. */
export function bulkLabel(pct: number, thresholdCents: number, t: Tr = EN): string {
  return t("quote.view.bulkLabel", { pct: String(Math.round(pct * 100)), amount: formatCentsShort(thresholdCents, t) });
}

/** The quote's processing-time estimate: "about 25 min" (lib/format). */
export { formatDuration as formatQuoteEta } from "@/lib/format";

/** What the customer is told about WHEN they pay, per charge_timing — the
 * short form beside the Convert button; the full sentence (with amounts)
 * sits under the quote (lib/billingCopy). */
export const CHARGE_BEFORE_COPY = CHARGED_AT_START;
export const CHARGE_AFTER_COPY = CHARGED_AFTER;
export const chargeBeforeCopy = chargedAtStart;
export const chargeAfterCopy = chargedAfter;

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

/** Customer words for the stages a quote can reuse (quote.view.reuse.*). */
const REUSE_STAGES: ReadonlySet<string> = new Set(["depth", "preprocess"]);

function reuseName(stage: string, t: Tr): string {
  return REUSE_STAGES.has(stage) ? t(`quote.view.reuse.${stage}`) : stage;
}

/** The length a quote charges for: the billable minutes ("3 min") when
 * the gateway rounds the video up to whole minutes (billable_minutes,
 * owner 2026-11-04; the rounding itself is said once, on Prices), else
 * the plain length (previews: "5 s"). */
export function billedLength(b: QuoteBreakdown, t: Tr = EN): string {
  if (b.billable_minutes !== undefined) return t("quote.view.minutes", { minutes: String(b.billable_minutes) });
  return formatVideoLength(b.billable_seconds ?? 0, t);
}

/** What a run makes, for the pay sheet, the price card and the tracker:
 * "4K · 60 fps · 3 min" (owner 2026-11-04). */
export function runFacts(
  params: { preset?: string; target_fps?: number } | undefined,
  breakdown: QuoteBreakdown | undefined,
  t: Tr = EN,
): string[] {
  const b = breakdown ?? {};
  const preset = params?.preset ?? b.preset;
  const fps = quotedFps(params, b.fps_factor);
  return [
    preset ? qualityName(preset, t) : null,
    fps !== null ? fpsLabel(fps, t) : null,
    b.billable_seconds !== undefined || b.billable_minutes !== undefined ? billedLength(b, t) : null,
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
 * rate (+25% at 30 fps), reused work, the bulk discount (its share and
 * threshold from /v1/pricing), "Minimum
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
  const t = useT();
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
    total > subtotal - reuse - (tierMode ? (discount?.cents ?? 0) : bulk + proOff) - (b.campaign_cents ?? 0);

  // the rate the run converts at (the chosen one, or the source's)
  const fps = quotedFps(result.params, b.fps_factor);
  const videoLabel =
    b.billable_seconds !== undefined ? (
      <>
        {t("quote.view.yourVideo", { length: billedLength(b, t) })}
        {fps !== null && b.fps_factor !== 1 ? (
          <span data-testid="quote-fps-factor">
            {" "}
            {t("quote.view.atFpsPct", { fps: String(fps), pct: percent(b.fps_factor!) })}
          </span>
        ) : null}
      </>
    ) : (
      t("quote.view.price")
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
                {b.preset
                  ? t("quote.view.lengthAtQuality", { length: billedLength(b, t), quality: qualityName(b.preset, t) })
                  : billedLength(b, t)}
                <span className="block text-[11px] text-fg-muted/80">
                  {t("quote.view.perMinute", {
                    minutes: String(b.billable_minutes ?? minutes.toFixed(1)),
                    rate: formatCents(cpm!, t),
                  })}
                </span>
              </>
            }
            value={formatCents(atRate, t)}
            testId="quote-base"
          />
          {b.fps_factor !== 1 && fps !== null ? (
            <Line
              label={
                <span data-testid="quote-fps-factor">
                  {t("quote.view.atFpsLabelPct", { fps: fpsLabel(fps, t), pct: percent(b.fps_factor!) })}
                </span>
              }
              value={`${fpsAdds >= 0 ? "+" : "−"}${formatCents(Math.abs(fpsAdds), t)}`}
            />
          ) : null}
        </>
      ) : (
        <Line
          label={videoLabel}
          value={formatCents(
            (technical ? (b.base_cents ?? subtotal) : subtotal) - fovCents,
            t,
          )}
          testId="quote-base"
        />
      )}
      {technical ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-fg-muted">
            {t("quote.view.howPriced")}
          </summary>
          <div className="mt-1.5 flex flex-col gap-1 ps-3">
            {hasDepthFactor ? (
              <Line
                label={
                  b.depth_res !== undefined
                    ? t("quote.view.depthDetailPx", { px: String(b.depth_res) })
                    : t("quote.view.depthDetail")
                }
                value={percent(b.depth_res_factor!)}
                testId="quote-depth-factor"
              />
            ) : null}
            {hasInpaintMult ? (
              <Line
                label={t("quote.view.edgeStyle")}
                value={percent(b.inpaint_multiplier!)}
                testId="quote-inpaint-multiplier"
              />
            ) : null}
          </div>
        </details>
      ) : null}
      {technical ? (
        <Line label={t("quote.view.subtotal")} value={formatCents(subtotal, t)} testId="quote-subtotal" />
      ) : (
        <span data-testid="quote-subtotal" hidden>
          {formatCents(subtotal, t)}
        </span>
      )}
      {/* owner 2026-11-07: free and always on at 1080p, when it applies */}
      {foveationIncludedApplied(result.foveation) ? (
        <Line label={foveatedDetail(t)} value={t("quote.view.included")} testId="quote-foveation-included" />
      ) : null}
      {b.foveation_factor !== undefined && b.foveation_factor !== 1 ? (
        <Line
          label={t("quote.view.namePct", { name: foveatedDetail(t), pct: percent(b.foveation_factor) })}
          value={
            b.foveation_cents !== undefined
              ? `+${formatCents(b.foveation_cents, t)}`
              : percent(b.foveation_factor)
          }
          testId="quote-foveation"
        />
      ) : null}
      {/* owner 2026-11-07: the File quality line in the gateway's words
          ("High quality +30%"); an older quote's Master bitrate as before */}
      {b.quality && b.quality !== "standard" && b.quality_label && addons[b.quality] ? (
        <Line label={b.quality_label} value={`+${formatCents(addons[b.quality] ?? 0, t)}`} testId="quote-quality" />
      ) : addons.master ? (
        <Line
          label={t("quote.view.masterBitrate", { master: "Master", pct: addonPct(addons.master, b, t) })}
          value={`+${formatCents(addons.master, t)}`}
          testId="quote-master"
        />
      ) : null}
      {addons.express ? (
        <Line
          label={t("quote.view.namePct", { name: t("quote.view.express"), pct: addonPct(addons.express, b, t) })}
          value={`+${formatCents(addons.express, t)}`}
          testId="quote-express"
        />
      ) : (b as Record<string, unknown>).express_included === true ? (
        <Line label={t("quote.view.express")} value={t("quote.view.included")} testId="quote-express" />
      ) : null}
      {reuseStages.length > 0 ? (
        <Line
          label={rich(
            t,
            "quote.view.reusing",
            { list: (c) => <span data-testid="quote-reuse-stages">{c}</span> },
            {
              stages: reuseStages
                .map((s) => reuseName(s, t))
                .reduce((a, b2) => t("quote.view.listAnd", { a, b: b2 })),
            },
          )}
          value={formatCents(-reuse, t)}
          testId="quote-reuse-discount"
          tone="discount"
        />
      ) : null}
      {tierMode && discount && discount.cents > 0 ? (
        <Line
          label={
            discount.kind === "tier"
              ? tierPriceLabel(discount.tier, result.tier_label, t)
              : <BulkLabel pct={discount.pct} />
          }
          value={formatCents(-discount.cents, t)}
          testId={discount.kind === "tier" ? "quote-tier" : "quote-bulk-discount"}
          tone="discount"
        />
      ) : null}
      {/* owner 2026-11-07: the launch offer, in the gateway's words, after
          the plan or Pro price */}
      {(b.campaign_cents ?? 0) > 0 ? (
        <Line
          label={offerLabel(b.campaign_pct, b.campaign_label, t)}
          value={formatCents(-(b.campaign_cents ?? 0), t)}
          testId="quote-campaign"
          tone="discount"
        />
      ) : null}
      {freePreview ? (
        <Line
          label={result.free_previews?.intro ? t("make.checkout.freePreviews.first") : t("make.checkout.freePreview")}
          value={
            typeof (b as Record<string, unknown>).price_without_free_cents === "number"
              ? formatCents(-((b as Record<string, unknown>).price_without_free_cents as number), t)
              : t("make.checkout.free")
          }
          testId="quote-free-preview"
          tone="discount"
        />
      ) : null}
      {!tierMode && bulk > 0 ? (
        <Line
          label={<PricingBulkLabel />}
          value={formatCents(-bulk, t)}
          testId="quote-bulk-discount"
          tone="discount"
        />
      ) : null}
      {!tierMode && proLine && proOff > 0 ? (
        // S3D-67: one compact line for members
        <Line
          label={`Pro −${proPercent(proLine.pct)}%`}
          value={formatCents(-proOff, t)}
          testId="quote-pro"
          tone="discount"
        />
      ) : null}
      {minimumApplied ? (
        <Line
          label={t("quote.view.minimum", { amount: formatCentsShort(total, t) })}
          value={formatCents(total, t)}
          testId="quote-minimum"
        />
      ) : null}
      <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-edge pt-2">
        <span className="font-medium">
          {rich(t, "quote.view.total", {
            note: (c) => <span className="text-xs font-normal text-fg-muted">{c}</span>,
          })}
        </span>
        <span
          data-testid="quote-total"
          className="font-mono text-base font-semibold"
        >
          {formatCents(total, t)}
        </span>
      </div>
      {/* gateway 00166: how it'd be paid, in the gateway's words */}
      {result.pay_split?.text && !freePreview ? (
        <p data-testid="quote-pay-split" className="text-end text-xs text-fg-muted tabular-nums">
          {result.pay_split.text}
        </p>
      ) : null}
      {(result.fps?.fps_capped || result.params?.fps_capped) && fps !== null ? (
        // owner 2026-11-04: the source is above 30 fps and there's no plan
        <p data-testid="quote-fps-capped" className="text-xs text-fg-muted">
          {t("quote.view.fpsCapped", { fps: fpsLabel(fps, t), business: "Business", studio: "Studio" })}
        </p>
      ) : null}
      {/* no Pro upsell on a plan's quote (Business and Studio include Pro) */}
      {result.pro === false && !(result.tier === "business" || result.tier === "studio") ? (
        <ProSaveLink step={result.step} />
      ) : null}
      {chargeLine ? (
        <p data-testid="quote-charge-timing" className="text-xs text-fg">
          {quoteChargeSentence(result.charge_timing, t)}
        </p>
      ) : null}
      {result.eta_seconds !== undefined && result.eta_seconds > 0 ? (
        <div className="flex items-baseline justify-between gap-3 text-xs text-fg-muted">
          <span>{chargeLine ? t("quote.view.estimatedTime") : t("quote.view.readyIn")}</span>
          <span data-testid="quote-eta">{formatDuration(result.eta_seconds, t)}</span>
        </div>
      ) : null}
    </div>
  );
}
