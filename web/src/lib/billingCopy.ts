/**
 * When we charge, in one place (S3D-19). Both methods: a run quoted over
 * the pre-charge threshold ($25) is charged when it starts and refunded in
 * full if it fails; a smaller run is added to the balance after it
 * succeeds, and the balance is charged within the account's window (1 hour
 * for a new account, from GET /v1/billing — never hardcoded) or when it
 * reaches the account's limit. No card holds. Short sentences (S3D-45).
 */

import { formatCents } from "@/components/steps/money";
import type { ChargeTiming, GatewayLimits } from "@/lib/api/types";

/** The gateway's default; GET /v1/limits rates.precharge_threshold_cents
 * is authoritative. */
export const DEFAULT_PRECHARGE_CENTS = 2500;

export function prechargeThreshold(limits: GatewayLimits | null): number {
  return limits?.rates?.precharge_threshold_cents ?? DEFAULT_PRECHARGE_CENTS;
}

/** "within 1 hour" / "within 4 hours" / "soon" when the window is unknown. */
export function balanceWindow(hours: number | undefined): string {
  if (hours === undefined || !(hours > 0)) return "soon";
  const h = Math.round(hours * 10) / 10;
  return `within ${h} hour${h === 1 ? "" : "s"}`;
}

/** The general rule, for onboarding and Account. */
export function chargeRule(
  thresholdCents = DEFAULT_PRECHARGE_CENTS,
  windowHours?: number,
): string {
  const t = formatCents(thresholdCents);
  return `Over ${t}: charged when the run starts, refunded if it fails. ${t} or less: added to your balance, charged ${balanceWindow(windowHours)}. Failed runs cost nothing.`;
}

/** The sentence under one quote. */
export function quoteChargeSentence(
  amountCents: number,
  timing: ChargeTiming | undefined,
  balanceLimitCents?: number,
  windowHours?: number,
): string {
  const amount = formatCents(amountCents);
  if (timing === "before") {
    return `We charge ${amount} when the run starts and refund it in full if it fails.`;
  }
  const limit =
    balanceLimitCents !== undefined
      ? ` or when it reaches ${formatCents(balanceLimitCents)}`
      : "";
  return `We add ${amount} to your balance after it succeeds. Your balance is charged ${balanceWindow(windowHours)}${limit}.`;
}
