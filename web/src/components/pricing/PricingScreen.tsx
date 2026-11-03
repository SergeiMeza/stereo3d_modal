"use client";

/**
 * /pricing — public, concise, reference-only (S3D-18, S3D-45): Lifelike
 * 3D only (S3D-01: new projects are Lifelike), "from $X a minute", one
 * compact table with the size per eye for the qualities the gateway
 * enables, the
 * preview's "from" price, one charging line and a "How pricing works"
 * popover. Every number comes from GET /v1/pricing.
 */

import Link from "next/link";
import type { JSX } from "react";

import { methodLimitText, sentenceCase } from "@/components/steps/methods";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { InfoPopover } from "@/components/ui/info-popover";
import type { Method, Preset, PublicPricing } from "@/lib/api/types";
import { fpsRule, usePricing } from "@/lib/api/usePricing";
import { useAuth } from "@/lib/auth";
import { CHARGED_AFTER, ROUNDED_UP_LINE } from "@/lib/billingCopy";
import { QUALITY_SHORT_SIDE, qualityName } from "@/lib/glossary";

import { PayPerVideoLine } from "./planCopy";
import { PlansSection } from "./PlansSection";

/** Per-eye size of a quality for a 16:9 video. */
function size169(p: Preset): string {
  const h = QUALITY_SHORT_SIDE[p];
  const w = Math.round((h * 16) / 9 / 2) * 2;
  return `${w}×${h} per eye`;
}


/** Lifelike 3D's prices (Classic 3D is retired for new projects, owner
 * 2026-11-04; an existing Classic project quotes on its own page). */
function LifelikePrices({
  pricing,
}: {
  pricing: PublicPricing;
}): JSX.Element | null {
  const method: Method = "lifelike";
  const m = pricing.methods[method];
  if (!m) return null;
  // pricing 2026-11: the list table, with the Pro price beside it
  const tiers = pricing.tiers?.lifelike_cents_per_minute;
  const list = tiers?.list ?? m.production_cents_per_minute;
  const pro = tiers?.pro;
  const rows = m.presets.filter((p) => typeof list[p] === "number");
  const from = Math.min(...rows.map((p) => list[p]!));
  return (
    <section
      data-testid={`pricing-${method}`}
      className="flex flex-col rounded-xl border border-edge bg-card p-6"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">Lifelike 3D</h2>
      </div>
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
              <td className="py-2 text-right font-mono">{formatCents(list[p]!)}</td>
              {pro ? (
                <td data-testid={`pro-${p}`} className="py-2 pl-4 text-right font-mono text-primary">
                  {pro[p] !== undefined ? formatCents(pro[p]!) : "–"}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
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
    </section>
  );
}

/** Add-ons, free previews and top-ups: three small cards (pricing 2026-11). */
function Extras({ pricing }: { pricing: PublicPricing }): JSX.Element {
  const a = pricing.addons ?? {};
  const fp = pricing.free_previews;
  const pct = (v?: number) => (v ? `+${Math.round(v * 100)}%` : "");
  const addons: [string, string, string][] = [
    ...(a.foveated ? ([["Foveated Detail", pct(a.foveated.pct), "More detail where you look"]] as [string, string, string][]) : []),
    ...(a.master ? ([["Master bitrate", pct(a.master.pct), "Higher-bitrate files"]] as [string, string, string][]) : []),
    ...(a.express ? ([["Express", pct(a.express.pct), "Up to about 2× faster on longer videos"]] as [string, string, string][]) : []),
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

export function PricingScreen(): JSX.Element {
  const pricing = usePricing();
  const { user } = useAuth();
  const pct = pricing ? Math.round(pricing.discount.pct * 100) : null;
  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Prices</h1>
        <p data-testid="pricing-subtitle" className="mt-2 text-fg-muted">
          <PayPerVideoLine pricing={pricing} />
        </p>
      </div>
      {pricing === null ? (
        <p className="mt-10 text-center text-fg-muted">Loading prices…</p>
      ) : (
        <>
          <div className="mx-auto mt-8 max-w-md">
            <LifelikePrices pricing={pricing} />
          </div>
          {pricing.pricing_model === "tiers" ? <Extras pricing={pricing} /> : null}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2 text-center">
            <p data-testid="pricing-charge-line" className="text-fg-muted">
              {CHARGED_AFTER} Runs over{" "}
              {formatCentsShort(pricing.precharge_threshold_cents)} are charged
              when they start and refunded if they fail.
            </p>
            <InfoPopover label="How pricing works">
              <span>
                <b>Per minute of video at {pricing.fps.base} fps.</b>{" "}
                {fpsRule(pricing)}. {ROUNDED_UP_LINE} Make only part of a
                video and pay only for that part.
              </span>
              <span>
                <b>{pct}% off</b> any run over{" "}
                {formatCentsShort(pricing.discount.threshold_cents)}.{" "}
                {(pricing.preview_minimum_cents ?? pricing.minimum_cents) ===
                pricing.minimum_cents ? (
                  <>
                    <b>Minimum charge {formatCentsShort(pricing.minimum_cents)}</b>{" "}
                    per run.
                  </>
                ) : (
                  <>
                    <b>Minimum charge</b>{" "}
                    {formatCentsShort(pricing.preview_minimum_cents ?? pricing.minimum_cents)}{" "}
                    per preview, {formatCentsShort(pricing.minimum_cents)} for
                    other runs.
                  </>
                )}
              </span>
              <span>
                <b>Over {formatCentsShort(pricing.precharge_threshold_cents)}:</b>{" "}
                charged when it starts. Cancel while it waits in line, or in
                its first minute, for a full refund. Refunded in full if it
                fails.
              </span>
              <span>
                <b>
                  {formatCentsShort(pricing.precharge_threshold_cents)} or less:
                </b>{" "}
                charged after it&apos;s done. Failed or cancelled runs are not
                charged.
              </span>
              <span>US dollars, excluding tax. Every file type is included.</span>
            </InfoPopover>
          </div>
        </>
      )}
      {pricing?.plans ? (
        <div className="mt-12">
          <PlansSection pricing={pricing} />
        </div>
      ) : null}
      <div className="mt-8 flex justify-center">
        <Link
          href={user ? "/projects" : "/signin"}
          className="rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground hover:bg-primary/80"
        >
          Start a project
        </Link>
      </div>
    </section>
  );
}
