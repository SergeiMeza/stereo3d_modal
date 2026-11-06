import { describe, expect, it } from "vitest";

import {
  anchorLine,
  anchorPlan,
  creditLine,
  proCreditCents,
  creditRules,
  creditShort,
  proCreditDays,
  planCadence,
  planName,
  plansFromPricing,
  planTerms,
} from "@/lib/pro/plans";

/** gateway 00102 /v1/pricing pro_plans */
const DEFS = [
  {
    id: "pro_yearly",
    interval: "year" as const,
    price_cents: 4999,
    intro: null,
    credit_cents: 2000,
  },
  {
    id: "pro_weekly",
    interval: "week" as const,
    price_cents: 399,
    intro: null,
    credit_cents: 2000,
  },
  {
    id: "pro_monthly",
    interval: "month" as const,
    price_cents: 499,
    intro: null,
    credit_cents: 2000,
  },
];

describe("Pro plans from /v1/pricing", () => {
  it("maps kinds and orders them Weekly first, as the app does", () => {
    const plans = plansFromPricing(DEFS);
    expect(plans.map((p) => [p.id, p.kind, p.price])).toEqual([
      ["pro_weekly", "weekly", "$3.99"],
      ["pro_monthly", "monthly", "$4.99"],
      ["pro_yearly", "yearly", "$49.99"],
    ]);
  });

  it("labels the credit to start, cadence and terms; no intro offers (owner 2026-11-07)", () => {
    const [weekly, monthly, yearly] = plansFromPricing(DEFS);
    expect(weekly.creditCents).toBe(2000);
    expect(creditLine(monthly.creditCents)).toBe(
      "$20 of usage credit when you join Pro (or the first time you sign in here with Pro from the app)",
    );
    expect(creditShort(2000)).toBe("$20 credit to start");
    expect(creditLine(null)).toBeNull();
    expect(creditRules(30)).toBe("Use it within 30 days. It isn't paid out.");
    expect(creditRules(null)).toBe("It isn't paid out.");
    // a plan without its own credit_cents takes pro_credit's for its kind, else its amount
    const def = { cents: 1800, once: true, expires_days: 30, rollover: false, paid_only: true, trial_counts: true, stacks_with_plan: false };
    const [bare] = plansFromPricing([{ id: "pro_weekly", interval: "week", price_cents: 399 }], { ...def, cents_by_kind: { pro_weekly: 1500 } });
    expect(bare.creditCents).toBe(1500);
    const [plain] = plansFromPricing([{ id: "pro_weekly", interval: "week", price_cents: 399 }], def);
    expect(plain.creditCents).toBe(1800);
    expect(proCreditCents({ pro_credit: def } as never)).toBe(1800);
    expect(proCreditDays({ pro_credit: def } as never)).toBe(30);
    expect(proCreditCents({ pro_plans: DEFS } as never)).toBe(2000);
    expect(proCreditCents({} as never)).toBeNull();
    expect(planCadence(monthly)).toBe("/ month");
    expect(planName(yearly)).toBe("Yearly");
    expect(planTerms(weekly)).toBe("Renews until you cancel.");
  });

  it("anchors the quote's sheet on Monthly", () => {
    const plans = plansFromPricing(DEFS);
    expect(anchorLine(anchorPlan(plans)!)).toBe("$4.99 a month");
    const noMonthly = plans.filter((p) => p.kind !== "monthly");
    expect(anchorLine(anchorPlan(noMonthly)!)).toBe("$49.99 a year");
    expect(anchorPlan([])).toBeNull();
  });
});
