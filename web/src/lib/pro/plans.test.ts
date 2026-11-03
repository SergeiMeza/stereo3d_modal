import { describe, expect, it } from "vitest";

import {
  anchorLine,
  anchorPlan,
  introLine,
  MOCK_PLANS,
  planCadence,
  planFromPackage,
  planName,
  plansFromPackages,
  planTerms,
} from "@/lib/pro/plans";
import type { PackageLike } from "@/lib/pro/plans";

function pkg(
  identifier: string,
  packageType: string,
  productId: string,
  productType: string,
  price: string,
  micros: number,
  period: string | null,
  intro: PackageLike["webBillingProduct"]["introPricePhase"] = null,
): PackageLike {
  return {
    identifier,
    packageType,
    webBillingProduct: {
      identifier: productId,
      productType,
      currentPrice: { formattedPrice: price, amountMicros: micros, currency: "USD" },
      normalPeriodDuration: period,
      introPricePhase: intro,
    },
  };
}

const PKGS: PackageLike[] = [
  pkg("$rc_annual", "$rc_annual", "web_pro_subs_1y_v2", "subscription", "$79.99", 79_990_000, "P1Y", {
    price: { formattedPrice: "$47.99" },
    periodDuration: "P1Y",
    cycleCount: 1,
  }),
  pkg("pass_3m", "custom", "web_pro_pass_3m_v1", "non_consumable", "$29.99", 29_990_000, null),
  pkg("$rc_weekly", "$rc_weekly", "web_pro_subs_1w_v2", "subscription", "$5.99", 5_990_000, "P1W", {
    price: { formattedPrice: "$3.99" },
    periodDuration: "P1W",
    cycleCount: 4,
  }),
  pkg("$rc_lifetime", "$rc_lifetime", "web_pro_subs_lifetime_v2", "non_consumable", "$149.99", 149_990_000, null),
  pkg("$rc_monthly", "$rc_monthly", "web_pro_subs_1m_v2", "subscription", "$8.99", 8_990_000, "P1M"),
];

describe("plans from RevenueCat packages", () => {
  it("maps kinds and orders them Weekly first, as the app does", () => {
    const plans = plansFromPackages(PKGS);
    // no Lifetime on the web, even when the offering carries one
    expect(plans.map((p) => p.kind)).toEqual(["weekly", "monthly", "yearly", "pass"]);
    expect(plans.find((p) => p.kind === "pass")?.months).toBe(3);
  });

  it("labels intro offers, cadence and terms", () => {
    const [weekly, monthly, yearly, pass] = plansFromPackages(PKGS);
    expect(introLine(weekly)).toBe("$3.99 / week for 4 weeks");
    expect(introLine(yearly)).toBe("$47.99 the first year");
    expect(introLine(monthly)).toBeNull();
    expect(planCadence(monthly)).toBe("/ month");
    expect(planCadence(pass)).toBe("once");
    expect(planName(pass)).toBe("3 months");
    expect(planTerms(pass)).toBe("3 months of Pro. Doesn't renew.");
    expect(planTerms(weekly)).toBe("Renews until you cancel.");
  });

  it("anchors the quote's sheet on Monthly", () => {
    const plans = plansFromPackages(PKGS);
    expect(anchorLine(anchorPlan(plans)!)).toBe("$8.99 a month");
    // without Monthly: the cheapest per month (Yearly)
    const noMonthly = plans.filter((p) => p.kind !== "monthly");
    expect(anchorLine(anchorPlan(noMonthly)!)).toBe("$79.99 a year");
    expect(anchorPlan([])).toBeNull();
  });

  it("mock plans carry the approved US prices (S3D-68)", () => {
    expect(MOCK_PLANS.map((p) => p.price)).toEqual(["$5.99", "$8.99", "$79.99", "$29.99"]);
    expect(planFromPackage(PKGS[0])?.kind).toBe("yearly");
  });
});
