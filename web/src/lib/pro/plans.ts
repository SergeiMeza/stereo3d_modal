/**
 * Pro plans as the web shows them (S3D-68), read from RevenueCat Web
 * Billing packages. Pure: the mapping and the labels are tested without the
 * SDK. Prices are RevenueCat's formatted strings in the buyer's currency;
 * nothing here hardcodes an amount except the mock plans.
 *
 * No Lifetime on the web (owner, 2026-11-03): the plans are Weekly,
 * Monthly, Yearly and the 3-month pass. A Lifetime package in the offering
 * is skipped. App Store Lifetime owners are still Pro (the gateway reads
 * the `pro` entitlement).
 */

export type PlanKind = "weekly" | "monthly" | "yearly" | "pass";

export interface ProPlan {
  /** RevenueCat package identifier ($rc_monthly…) */
  id: string;
  productId: string;
  kind: PlanKind;
  /** "$8.99" */
  price: string;
  amountMicros: number;
  currency: string;
  /** a pass's months (3) */
  months: number | null;
  /** introductory price: "$3.99" for `cycles` periods of `per` */
  intro: { price: string; per: PlanKind | null; cycles: number } | null;
}

/** The parts of a purchases-js Package this reads. */
export interface PackageLike {
  identifier: string;
  packageType: string;
  webBillingProduct: {
    identifier: string;
    productType: string;
    currentPrice: { formattedPrice: string; amountMicros: number; currency: string };
    normalPeriodDuration: string | null;
    introPricePhase?: {
      price: { formattedPrice: string } | null;
      periodDuration: string | null;
      cycleCount: number;
    } | null;
  };
}

const PASS_RE = /_pass_(\d+)m/;

const PERIOD_KIND: Record<string, PlanKind> = {
  P1W: "weekly",
  P7D: "weekly",
  P1M: "monthly",
  P1Y: "yearly",
  P12M: "yearly",
};

const PACKAGE_KIND: Record<string, PlanKind> = {
  $rc_weekly: "weekly",
  $rc_monthly: "monthly",
  $rc_annual: "yearly",
};

/** Order on the page: the app's paywall leads with Weekly (PRC-05). */
const ORDER: PlanKind[] = ["weekly", "monthly", "yearly", "pass"];

export function planFromPackage(p: PackageLike): ProPlan | null {
  const prod = p.webBillingProduct;
  const pass = PASS_RE.exec(prod.identifier);
  let kind: PlanKind | undefined;
  if (pass) kind = "pass";
  else if (prod.productType === "subscription") {
    kind = PERIOD_KIND[prod.normalPeriodDuration ?? ""] ?? PACKAGE_KIND[p.packageType];
  }
  // anything else one-time (Lifetime) isn't sold on the web
  if (!kind) return null;
  const ip = prod.introPricePhase;
  return {
    id: p.identifier,
    productId: prod.identifier,
    kind,
    price: prod.currentPrice.formattedPrice,
    amountMicros: prod.currentPrice.amountMicros,
    currency: prod.currentPrice.currency,
    months: pass ? Number(pass[1]) : null,
    intro:
      ip?.price != null
        ? {
            price: ip.price.formattedPrice,
            per: PERIOD_KIND[ip.periodDuration ?? ""] ?? null,
            cycles: Math.max(1, ip.cycleCount || 1),
          }
        : null,
  };
}

/** Plans in page order, one per kind (the first package of a kind wins). */
export function plansFromPackages(pkgs: PackageLike[]): ProPlan[] {
  const byKind = new Map<PlanKind, ProPlan>();
  for (const p of pkgs) {
    const plan = planFromPackage(p);
    if (plan && !byKind.has(plan.kind)) byKind.set(plan.kind, plan);
  }
  return ORDER.flatMap((k) => (byKind.has(k) ? [byKind.get(k)!] : []));
}

const NAME: Record<PlanKind, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
  pass: "Pass",
};

const UNIT: Partial<Record<PlanKind, string>> = {
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

export function planName(p: ProPlan): string {
  return p.kind === "pass" ? `${p.months ?? 3} months` : NAME[p.kind];
}

/** "/ week"; "once" for a pass. */
export function planCadence(p: ProPlan): string {
  const unit = UNIT[p.kind];
  return unit ? `/ ${unit}` : "once";
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
  if (p.kind === "pass") return `${p.months ?? 3} months of Pro. Doesn't renew.`;
  return "Renews until you cancel.";
}

/** Price per month in micros (for "best value"; passes: null). */
export function monthlyMicros(p: ProPlan): number | null {
  if (p.kind === "weekly") return (p.amountMicros * 52) / 12;
  if (p.kind === "monthly") return p.amountMicros;
  if (p.kind === "yearly") return p.amountMicros / 12;
  return null;
}

/** The one-line anchor for the quote's sheet: Monthly when sold, else the
 * plan that costs least per month. "$8.99 a month". */
export function anchorPlan(plans: ProPlan[]): ProPlan | null {
  const monthly = plans.find((p) => p.kind === "monthly");
  if (monthly) return monthly;
  const recurring = plans
    .map((p) => [p, monthlyMicros(p)] as const)
    .filter((x): x is readonly [ProPlan, number] => x[1] !== null)
    .sort((a, b) => a[1] - b[1]);
  return recurring[0]?.[0] ?? plans[0] ?? null;
}

export function anchorLine(p: ProPlan): string {
  const unit = UNIT[p.kind];
  return unit ? `${p.price} a ${unit}` : `${p.price} once`;
}

/** The approved web price list (S3D-68), for mock mode and the dev preview. */
export const MOCK_PLANS: ProPlan[] = [
  {
    id: "$rc_weekly",
    productId: "web_pro_subs_1w_v2",
    kind: "weekly",
    price: "$5.99",
    amountMicros: 5_990_000,
    currency: "USD",
    months: null,
    intro: { price: "$3.99", per: "weekly", cycles: 4 },
  },
  {
    id: "$rc_monthly",
    productId: "web_pro_subs_1m_v2",
    kind: "monthly",
    price: "$8.99",
    amountMicros: 8_990_000,
    currency: "USD",
    months: null,
    intro: null,
  },
  {
    id: "$rc_annual",
    productId: "web_pro_subs_1y_v2",
    kind: "yearly",
    price: "$79.99",
    amountMicros: 79_990_000,
    currency: "USD",
    months: null,
    intro: { price: "$47.99", per: "yearly", cycles: 1 },
  },
  {
    id: "pass_3m",
    productId: "web_pro_pass_3m_v1",
    kind: "pass",
    price: "$29.99",
    amountMicros: 29_990_000,
    currency: "USD",
    months: 3,
    intro: null,
  },
];
