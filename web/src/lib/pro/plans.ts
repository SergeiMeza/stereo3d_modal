/**
 * Pro plans as the web shows them (S3D-68), from GET /v1/pricing pro_plans
 * (gateway 00102: web Pro on our own Stripe subscriptions). Pure: the
 * mapping and the labels are tested on their own. Prices are USD.
 *
 * Web Pro is Weekly, Monthly and Yearly only (owner, 2026-11-03). App
 * Store Lifetime and pass holders are still Pro when the gateway says so.
 * No intro offers on the web since 2026-11-07. Every paid Pro grants a
 * monthly usage credit (pro_plans[].credit_cents / pro_credit): it
 * expires at the month's end and is never paid out.
 */

import type { ProPlanDef, PublicPricing } from "@/lib/api/types";

export type PlanKind = "weekly" | "monthly" | "yearly";

export interface ProPlan {
  /** our plan id: pro_weekly | pro_monthly | pro_yearly */
  id: string;
  productId: string;
  kind: PlanKind;
  /** "$4.99" */
  price: string;
  amountMicros: number;
  currency: string;
  /** usage credit it grants every month, in cents (null: none sent) */
  creditCents: number | null;
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

/** GET /v1/pricing pro_plans → the page's plans (Stripe checkout). The
 * credit is the plan's own credit_cents, else pro_credit's for its id. */
export function plansFromPricing(
  defs: readonly ProPlanDef[],
  credit?: PublicPricing["pro_credit"],
): ProPlan[] {
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
      creditCents: d.credit_cents ?? credit?.cents?.[d.id as keyof NonNullable<typeof credit>["cents"]] ?? null,
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

/** "$20" for a credit in cents (whole dollars without cents). */
export function creditAmount(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : usd(cents);
}

/** "$20 of usage credit every month"; null without a credit. */
export function creditLine(cents: number | null | undefined): string | null {
  return cents ? `${creditAmount(cents)} of usage credit every month` : null;
}

/** The credit's rules in one line (owner 2026-11-07). */
export const PRO_CREDIT_RULES = "The credit expires at the end of each month and isn't paid out.";

/** Pro's monthly credit from GET /v1/pricing: Monthly's (every paid web Pro
 * gets the same), else the first plan's; null when the gateway sends none. */
export function proCreditCents(pricing: PublicPricing | null | undefined): number | null {
  if (!pricing) return null;
  const c = pricing.pro_credit?.cents;
  return (
    c?.pro_monthly ??
    pricing.pro_plans?.find((p) => p.id === "pro_monthly")?.credit_cents ??
    pricing.pro_plans?.find((p) => p.credit_cents)?.credit_cents ??
    null
  );
}

/** Lifetime's monthly credit (App Store Lifetime), null when not sent. */
export function lifetimeCreditCents(pricing: PublicPricing | null | undefined): number | null {
  return pricing?.pro_credit?.cents?.pro_lifetime ?? null;
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
 * plan that costs least per month. "$4.99 a month". */
export function anchorPlan(plans: ProPlan[]): ProPlan | null {
  const monthly = plans.find((p) => p.kind === "monthly");
  if (monthly) return monthly;
  const recurring = plans.map((p) => [p, monthlyMicros(p)] as const).sort((a, b) => a[1] - b[1]);
  return recurring[0]?.[0] ?? plans[0] ?? null;
}

export function anchorLine(p: ProPlan): string {
  return `${p.price} a ${UNIT[p.kind]}`;
}
