import { describe, expect, it } from "vitest";

import {
  anchorLine,
  anchorPlan,
  introLine,
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
    price_cents: 7999,
    intro: { price_cents: 4799, cycles: 1 },
  },
  {
    id: "pro_weekly",
    interval: "week" as const,
    price_cents: 599,
    intro: { price_cents: 399, cycles: 4 },
  },
  {
    id: "pro_monthly",
    interval: "month" as const,
    price_cents: 899,
    intro: null,
  },
];

describe("Pro plans from /v1/pricing", () => {
  it("maps kinds and orders them Weekly first, as the app does", () => {
    const plans = plansFromPricing(DEFS);
    expect(plans.map((p) => [p.id, p.kind, p.price])).toEqual([
      ["pro_weekly", "weekly", "$5.99"],
      ["pro_monthly", "monthly", "$8.99"],
      ["pro_yearly", "yearly", "$79.99"],
    ]);
  });

  it("labels intro offers, cadence and terms", () => {
    const [weekly, monthly, yearly] = plansFromPricing(DEFS);
    expect(introLine(weekly)).toBe("$3.99 / week for 4 weeks");
    expect(introLine(yearly)).toBe("$47.99 the first year");
    expect(introLine(monthly)).toBeNull();
    expect(planCadence(monthly)).toBe("/ month");
    expect(planName(yearly)).toBe("Yearly");
    expect(planTerms(weekly)).toBe("Renews until you cancel.");
  });

  it("anchors the quote's sheet on Monthly", () => {
    const plans = plansFromPricing(DEFS);
    expect(anchorLine(anchorPlan(plans)!)).toBe("$8.99 a month");
    const noMonthly = plans.filter((p) => p.kind !== "monthly");
    expect(anchorLine(anchorPlan(noMonthly)!)).toBe("$79.99 a year");
    expect(anchorPlan([])).toBeNull();
  });
});
