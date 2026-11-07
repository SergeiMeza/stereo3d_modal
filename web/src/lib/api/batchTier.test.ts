/**
 * D15 (gateway 5ce38a4): Billing carries the app's batch ladder in tier
 * and the web's in web_tier; the web goes by web_tier, and by tier on
 * gateways that send only that.
 */
import { describe, expect, it } from "vitest";

import { batchTierOf, type BillingTier } from "./types";

const app: BillingTier = { cap_cents: 5000, window_hours: 24, lifetime_paid_cents: 0, hold_threshold_cents: 2500 };
const web: BillingTier = { cap_cents: 2500, window_hours: 1, lifetime_paid_cents: 0, hold_threshold_cents: 2500, next_tier: { min_paid_cents: 5000, cap_cents: 5000 } };

describe("the web's batch tier (D15)", () => {
  it("both keys: web_tier's cap and window", () => {
    const t = batchTierOf({ tier: app, web_tier: web });
    expect(t?.cap_cents).toBe(2500);
    expect(t?.window_hours).toBe(1);
  });

  it("only tier (an older gateway): tier's", () => {
    const t = batchTierOf({ tier: app });
    expect(t?.cap_cents).toBe(5000);
    expect(t?.window_hours).toBe(24);
  });

  it("neither: none", () => {
    expect(batchTierOf({})).toBeNull();
    expect(batchTierOf(null)).toBeNull();
  });
});
