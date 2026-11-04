/**
 * Pro plans as the web shows them (S3D-68), from GET /v1/pricing pro_plans
 * (gateway 00102: web Pro on our own Stripe subscriptions). Pure: the
 * mapping and the labels are tested on their own. Prices are USD.
 *
 * Web Pro is Weekly, Monthly and Yearly only (owner, 2026-11-03). App
 * Store Lifetime and pass holders are still Pro when the gateway says so.
 */

import type { ProPlanDef } from "@/lib/api/types";

export type PlanKind = "weekly" | "monthly" | "yearly";

export interface ProPlan {
  /** our plan id: pro_weekly | pro_monthly | pro_yearly */
  id: string;
  productId: string;
  kind: PlanKind;
  /** "$8.99" */
  price: string;
  amountMicros: number;
  currency: string;
  /** introductory price: "$3.99" for `cycles` periods of `per` */
  intro: { price: string; per: PlanKind | null; cycles: number } | null;
}

/** Order on the page: the app's paywall leads with Weekly (PRC-05). */
const ORDER: PlanKind[] = ["weekly", "monthly", "yearly"];

const INTERVAL_KIND: Record<string, PlanKind> = {
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** GET /v1/pricing pro_plans → the page's plans (Stripe checkout). */
export function plansFromPricing(defs: readonly ProPlanDef[]): ProPlan[] {
  const out: ProPlan[] = [];
  for (const d of defs) {
    const kind = INTERVAL_KIND[d.interval];
    if (!kind || out.some((p) => p.kind === kind)) continue;
    out.push({
      id: d.id,
      productId: d.id,
      kind,
      price: usd(d.price_cents),
      amountMicros: d.price_cents * 10_000,
      currency: "USD",
      intro: d.intro ? { price: usd(d.intro.price_cents), per: kind, cycles: Math.max(1, d.intro.cycles) } : null,
    });
  }
  return ORDER.flatMap((k) => out.filter((p) => p.kind === k));
}

const NAME: Record<PlanKind, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

const UNIT: Record<PlanKind, string> = {
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

export function planName(p: ProPlan): string {
  return NAME[p.kind];
}

/** "/ week" */
export function planCadence(p: ProPlan): string {
  return `/ ${UNIT[p.kind]}`;
}

/** "$3.99 / week for 4 weeks", "$47.99 the first year"; null without one. */
export function introLine(p: ProPlan): string | null {
  if (!p.intro) return null;
  const unit = UNIT[p.intro.per ?? p.kind];
  if (!unit) return null;
  if (p.intro.cycles <= 1) return `${p.intro.price} the first ${unit}`;
  return `${p.intro.price} / ${unit} for ${p.intro.cycles} ${unit}s`;
}

/** What the plan's footnote says it does. */
export function planTerms(p: ProPlan): string {
  void p;
  return "Renews until you cancel.";
}

/** Price per month in micros (for "best value"). */
export function monthlyMicros(p: ProPlan): number {
  if (p.kind === "weekly") return (p.amountMicros * 52) / 12;
  if (p.kind === "monthly") return p.amountMicros;
  return p.amountMicros / 12;
}

/** The one-line anchor for the quote's sheet: Monthly when sold, else the
 * plan that costs least per month. "$8.99 a month". */
export function anchorPlan(plans: ProPlan[]): ProPlan | null {
  const monthly = plans.find((p) => p.kind === "monthly");
  if (monthly) return monthly;
  const recurring = plans.map((p) => [p, monthlyMicros(p)] as const).sort((a, b) => a[1] - b[1]);
  return recurring[0]?.[0] ?? plans[0] ?? null;
}

export function anchorLine(p: ProPlan): string {
  return `${p.price} a ${UNIT[p.kind]}`;
}
