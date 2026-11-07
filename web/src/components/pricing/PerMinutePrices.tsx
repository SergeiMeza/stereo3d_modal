"use client";

/**
 * The per-minute price table (S3D-18, pricing 2026-11), shared by /pricing
 * and Plan & billing so prices live in one place (owner 2026-11-07). Every
 * number comes from GET /v1/pricing: the list prices and each plan's own
 * column (tiers.lifelike_cents_per_minute), the same figures quotes use.
 *
 * - /pricing: the list prices with the Pro column beside them (no `plan`).
 * - Plan & billing: `plan` picks whose prices to show; a plan's price comes
 *   with the list price struck through beside it.
 */

import { creditLine, creditRules, proCreditCents, proCreditDays } from "@/lib/pro/plans";
import type { JSX, ReactNode } from "react";

import { methodLimitText, sentenceCase } from "@/components/steps/methods";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import type { Method, Preset, PublicPricing } from "@/lib/api/types";
import { fpsRule } from "@/lib/api/usePricing";
import { ROUNDED_UP_LINE } from "@/lib/billingCopy";
import { QUALITY_SHORT_SIDE, qualityName } from "@/lib/glossary";
import { FOVEATED_DETAIL, foveationIncludedPresets } from "@/lib/foveation";
import { QUALITY_STEPS, qualityName as fileQualityName, qualityPct, qualitySteps } from "@/components/steps/FileQuality";
import { activeCampaign, campaignBadge, campaignNote } from "@/lib/campaign";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

/** Whose prices: the list, or a plan's own column. */
export type PriceKey = "list" | "pro" | "business" | "studio";

/** Per-eye size of a quality for a 16:9 video. */
export function size169(p: Preset, t: Tr = EN): string {
  const h = QUALITY_SHORT_SIDE[p];
  const w = Math.round((h * 16) / 9 / 2) * 2;
  return t("pricing.table.perEye", { size: `${w}×${h}` });
}


/** Lifelike 3D's prices (Classic 3D is retired for new projects, owner
 * 2026-11-04; an existing Classic project quotes on its own page). */
export function LifelikePrices({
  pricing,
  plan,
  title = "Lifelike 3D",
  caption,
  testId,
  compact = false,
  children,
}: {
  pricing: PublicPricing;
  /** whose prices; none: the list with the Pro column (/pricing) */
  plan?: PriceKey;
  title?: string;
  /** a short line under the title ("With Studio, 25% off") */
  caption?: string;
  testId?: string;
  /** without the fps, rounding and limit lines (a second card beside one) */
  compact?: boolean;
  /** under the table: an upgrade button */
  children?: ReactNode;
}): JSX.Element | null {
  const t = useT();
  const method: Method = "lifelike";
  const m = pricing.methods[method];
  if (!m) return null;
  // pricing 2026-11: the list table, with the Pro price beside it
  const tiers = pricing.tiers?.lifelike_cents_per_minute;
  const list = tiers?.list ?? m.production_cents_per_minute;
  // a plan's own column (Plan & billing); the list for no plan
  const own = plan && plan !== "list" ? tiers?.[plan] : undefined;
  const mine = plan === undefined || plan === "list" ? list : own;
  if (!mine) return null;
  const pro = plan === undefined ? tiers?.pro : undefined;
  const rows = m.presets.filter((p) => typeof mine[p] === "number");
  if (rows.length === 0) return null;
  const from = Math.min(...rows.map((p) => mine[p]!));
  return (
    <section
      data-testid={testId ?? `pricing-${method}`}
      className="flex flex-col rounded-xl border border-edge bg-card p-6"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      {caption ? <p className="mt-0.5 text-xs text-primary">{caption}</p> : null}
      <p className="mt-2 text-2xl font-semibold">
        {t("pricing.table.from", { price: formatCentsShort(from, t) })}{" "}
        <span className="text-sm font-normal text-fg-muted">
          {t("pricing.table.aMinuteAt", { fps: pricing.fps.base })}
        </span>
      </p>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-xs text-fg-muted">
            <th className="py-1.5 text-left font-normal">{t("pricing.table.quality")}</th>
            <th className="py-1.5 text-right font-normal">
              {t("pricing.table.perMinute", { fps: pricing.fps.base })}
            </th>
            {pro ? (
              <th className="py-1.5 pl-4 text-right font-normal text-primary">
                {pricing.pro_discount?.pct
                  ? t("pricing.table.withProOff", { pro: "Pro", pct: Math.round(pricing.pro_discount.pct * 100) })
                  : t("pricing.table.withPro", { pro: "Pro" })}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p} className="border-t border-edge">
              <td className="py-2">
                {qualityName(p)}
                <span className="ml-2 font-mono text-[11px] text-fg-muted">
                  {size169(p, t)}
                </span>
                {/* owner 2026-11-07: a badge only; the prices stay the list */}
                {campaignBadge(pricing, p) ? (
                  <span
                    data-testid={`offer-${p}`}
                    title={activeCampaign(pricing)?.label}
                    className="ml-2 inline-block rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-px text-[10px] leading-4 text-emerald-300"
                  >
                    {campaignBadge(pricing, p)}
                  </span>
                ) : null}
              </td>
              <td data-testid={`price-${p}`} className="py-2 text-right font-mono">
                {own && typeof list[p] === "number" && list[p]! > mine[p]! ? (
                  <span data-testid={`list-${p}`} className="mr-2 text-xs text-fg-muted line-through">
                    {formatCents(list[p]!, t)}
                  </span>
                ) : null}
                {formatCents(mine[p]!, t)}
              </td>
              {pro ? (
                <td data-testid={`pro-${p}`} className="py-2 pl-4 text-right font-mono text-primary">
                  {pro[p] !== undefined ? formatCents(pro[p]!, t) : "–"}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {campaignNote(pricing) ? (
        <p data-testid="pricing-offer" className="mt-2 text-xs text-emerald-300">
          {campaignNote(pricing)}
        </p>
      ) : null}
      {/* owner 2026-11-07: the credit joining Pro gives, beside its column */}
      {pro && creditLine(proCreditCents(pricing)) ? (
        <p data-testid="pricing-pro-credit" className="mt-2 text-xs text-primary">
          {t("pricing.table.proCredit", { pro: "Pro", credit: creditLine(proCreditCents(pricing)) })}{" "}
          {creditRules(proCreditDays(pricing))}
        </p>
      ) : null}
      {compact ? null : (
        <>
          <p data-testid="pricing-fps-rule" className="mt-2 text-xs text-fg-muted">
            {fpsRule(pricing)}
          </p>
          <p data-testid="pricing-rounding" className="mt-1 text-xs text-fg-muted">
            {ROUNDED_UP_LINE}
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            {t("pricing.table.limitAndPreviews", {
              limit: sentenceCase(methodLimitText(method, null, pricing)),
              price: formatCentsShort(pricing.preview_minimum_cents ?? pricing.minimum_cents, t),
            })}
          </p>
        </>
      )}
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}

/** "More detail where you look · included at 1080p". */
function foveatedWhat(included: readonly string[], t: Tr = EN): string {
  const at = included.map((p) => qualityName(p as Preset)).join(", ");
  return at ? t("pricing.extras.foveatedIncludedAt", { at }) : t("pricing.extras.foveated");
}

/** Add-ons, free previews and top-ups: three small cards (pricing 2026-11). */
export function Extras({ pricing }: { pricing: PublicPricing }): JSX.Element {
  const t = useT();
  const a = pricing.addons ?? {};
  const fp = pricing.free_previews;
  const pct = (v?: number) => (v ? `+${Math.round(v * 100)}%` : "");
  const addons: [string, string, string][] = [
    // owner 2026-11-07: included at the qualities /v1/pricing lists (1080p)
    ...(a.foveated
      ? ([[FOVEATED_DETAIL, pct(a.foveated.pct), foveatedWhat(foveationIncludedPresets(pricing), t)]] as [string, string, string][])
      : []),
    // owner 2026-11-07: File quality's High and Master, in place of the
    // Master bitrate add-on; their shares from /v1/pricing
    ...qualitySteps(pricing)
      .filter((q) => q !== "standard")
      .map((q): [string, string, string] => [
        t("pricing.extras.fileQuality", { quality: fileQualityName(q) }),
        pct(qualityPct(pricing, q)),
        QUALITY_STEPS.find((s) => s.value === q)?.hint ?? "",
      ]),
    ...(a.express ? ([[t("pricing.extras.express"), pct(a.express.pct), t("pricing.extras.expressWhat")]] as [string, string, string][]) : []),
  ];
  const card = "flex flex-col gap-3 rounded-xl border border-edge bg-card p-5";
  return (
    <div className="mx-auto mt-6 grid max-w-4xl gap-4 sm:grid-cols-3">
      {addons.length > 0 ? (
        <section data-testid="pricing-addons" className={card}>
          <h2 className="text-sm font-semibold">{t("pricing.extras.addons")}</h2>
          <ul className="flex flex-col gap-2.5 text-sm">
            {addons.map(([name, p, what]) => (
              <li key={name} className="flex flex-col">
                <span className="flex justify-between gap-2">
                  {name}
                  <span className="font-mono text-fg-muted">{p}</span>
                </span>
                <span className="text-xs text-fg-muted">{what}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {fp ? (
        <section data-testid="pricing-free-previews" className={card}>
          <h2 className="text-sm font-semibold">{t("pricing.extras.freePreviews")}</h2>
          <ul className="flex flex-col gap-2 text-sm">
            <li className="flex justify-between gap-2">
              Pro <span className="text-fg-muted tabular-nums">{t("pricing.extras.perMonth", { count: fp.allowances.pro_monthly ?? 0 })}</span>
            </li>
            {pricing.plans?.business ? (
              <li className="flex justify-between gap-2">
                Business <span className="text-fg-muted tabular-nums">{t("pricing.extras.perMonth", { count: pricing.plans.business.free_previews_per_period })}</span>
              </li>
            ) : null}
            {pricing.plans?.studio ? (
              <li className="flex justify-between gap-2">
                Studio <span className="text-fg-muted tabular-nums">{t("pricing.extras.perMonth", { count: pricing.plans.studio.free_previews_per_period })}</span>
              </li>
            ) : null}
          </ul>
          <p className="text-xs text-fg-muted">
            {(fp.allowances.intro ?? 0) > 0 ? `${t("pricing.extras.firstFree")} ` : ""}
            {fp.rollover
              ? t("pricing.extras.each", { seconds: fp.unit_seconds })
              : t("pricing.extras.eachNoRollover", { seconds: fp.unit_seconds })}
          </p>
        </section>
      ) : null}
      <section data-testid="pricing-topups" className={card}>
        <h2 className="text-sm font-semibold">{t("pricing.extras.balance")}</h2>
        <p className="text-sm">{t("pricing.extras.addFunds", { amount: formatCentsShort(1000, t) })}</p>
        <p className="text-xs text-fg-muted">{t("pricing.extras.refundable", { days: 14 })}</p>
      </section>
    </div>
  );
}
