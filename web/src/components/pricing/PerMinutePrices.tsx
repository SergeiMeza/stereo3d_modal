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

import { creditLine, PRO_CREDIT_RULES, proCreditCents } from "@/lib/pro/plans";
import type { JSX, ReactNode } from "react";

import { methodLimitText, sentenceCase } from "@/components/steps/methods";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import type { Method, Preset, PublicPricing } from "@/lib/api/types";
import { fpsRule } from "@/lib/api/usePricing";
import { ROUNDED_UP_LINE } from "@/lib/billingCopy";
import { QUALITY_SHORT_SIDE, qualityName } from "@/lib/glossary";

/** Whose prices: the list, or a plan's own column. */
export type PriceKey = "list" | "pro" | "business" | "studio";

/** Per-eye size of a quality for a 16:9 video. */
export function size169(p: Preset): string {
  const h = QUALITY_SHORT_SIDE[p];
  const w = Math.round((h * 16) / 9 / 2) * 2;
  return `${w}×${h} per eye`;
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
        from {formatCentsShort(from)}{" "}
        <span className="text-sm font-normal text-fg-muted">
          a minute at {pricing.fps.base} fps
        </span>
      </p>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-xs text-fg-muted">
            <th className="py-1.5 text-left font-normal">Quality</th>
            <th className="py-1.5 text-right font-normal">
              Per minute, {pricing.fps.base} fps
            </th>
            {pro ? (
              <th className="py-1.5 pl-4 text-right font-normal text-primary">
                With Pro{pricing.pro_discount?.pct ? ` (−${Math.round(pricing.pro_discount.pct * 100)}%)` : ""}
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
                  {size169(p)}
                </span>
              </td>
              <td data-testid={`price-${p}`} className="py-2 text-right font-mono">
                {own && typeof list[p] === "number" && list[p]! > mine[p]! ? (
                  <span data-testid={`list-${p}`} className="mr-2 text-xs text-fg-muted line-through">
                    {formatCents(list[p]!)}
                  </span>
                ) : null}
                {formatCents(mine[p]!)}
              </td>
              {pro ? (
                <td data-testid={`pro-${p}`} className="py-2 pl-4 text-right font-mono text-primary">
                  {pro[p] !== undefined ? formatCents(pro[p]!) : "–"}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {/* owner 2026-11-07: Pro's monthly usage credit, beside its column */}
      {pro && creditLine(proCreditCents(pricing)) ? (
        <p data-testid="pricing-pro-credit" className="mt-2 text-xs text-primary">
          Pro also includes {creditLine(proCreditCents(pricing))}. {PRO_CREDIT_RULES}
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
            {sentenceCase(methodLimitText(method, null, pricing))} · previews from{" "}
            {formatCentsShort(pricing.preview_minimum_cents ?? pricing.minimum_cents)}
          </p>
        </>
      )}
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}

/** Add-ons, free previews and top-ups: three small cards (pricing 2026-11). */
export function Extras({ pricing }: { pricing: PublicPricing }): JSX.Element {
  const a = pricing.addons ?? {};
  const fp = pricing.free_previews;
  const pct = (v?: number) => (v ? `+${Math.round(v * 100)}%` : "");
  const addons: [string, string, string][] = [
    ...(a.foveated ? ([["Foveated Detail", pct(a.foveated.pct), "More detail where you look"]] as [string, string, string][]) : []),
    ...(a.master ? ([["Master bitrate", pct(a.master.pct), "Higher-bitrate files"]] as [string, string, string][]) : []),
    ...(a.express ? ([["Express", pct(a.express.pct), "First in line"]] as [string, string, string][]) : []),
  ];
  const card = "flex flex-col gap-3 rounded-xl border border-edge bg-card p-5";
  return (
    <div className="mx-auto mt-6 grid max-w-4xl gap-4 sm:grid-cols-3">
      {addons.length > 0 ? (
        <section data-testid="pricing-addons" className={card}>
          <h2 className="text-sm font-semibold">Add-ons</h2>
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
          <h2 className="text-sm font-semibold">Free previews</h2>
          <ul className="flex flex-col gap-2 text-sm">
            <li className="flex justify-between gap-2">
              Pro <span className="text-fg-muted tabular-nums">{fp.allowances.pro_monthly ?? 0} a month</span>
            </li>
            {pricing.plans?.business ? (
              <li className="flex justify-between gap-2">
                Business <span className="text-fg-muted tabular-nums">{pricing.plans.business.free_previews_per_period} a month</span>
              </li>
            ) : null}
            {pricing.plans?.studio ? (
              <li className="flex justify-between gap-2">
                Studio <span className="text-fg-muted tabular-nums">{pricing.plans.studio.free_previews_per_period} a month</span>
              </li>
            ) : null}
          </ul>
          <p className="text-xs text-fg-muted">
            {(fp.allowances.intro ?? 0) > 0 ? "Your first preview is free. " : ""}
            {fp.unit_seconds} s each{fp.rollover ? "" : ", no rollover"}.
          </p>
        </section>
      ) : null}
      <section data-testid="pricing-topups" className={card}>
        <h2 className="text-sm font-semibold">Balance</h2>
        <p className="text-sm">Add funds from $10 and pay runs from your balance.</p>
        <p className="text-xs text-fg-muted">Unspent funds can be refunded within 14 days.</p>
      </section>
    </div>
  );
}
