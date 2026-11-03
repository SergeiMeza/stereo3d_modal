/**
 * When we charge, in one place (S3D-19). Both methods: a run quoted over
 * the pre-charge threshold ($25) is charged when it starts and refunded in
 * full if it fails; a smaller run is added to the balance after it
 * succeeds, and the balance is charged within 4 hours or when it reaches
 * the account's limit. No card holds. Every quote, run, the onboarding and
 * Account pages read these sentences.
 */

import { formatCents } from "@/components/steps/money";
import type { ChargeTiming, GatewayLimits } from "@/lib/api/types";

/** The gateway's default; GET /v1/limits rates.precharge_threshold_cents
 * is authoritative. */
export const DEFAULT_PRECHARGE_CENTS = 2500;
/** The balance window (hours) — the gateway's batch window. */
export const BALANCE_WINDOW_HOURS = 4;

export function prechargeThreshold(limits: GatewayLimits | null): number {
  return limits?.rates?.precharge_threshold_cents ?? DEFAULT_PRECHARGE_CENTS;
}

/** The general rule, for onboarding and Account. */
export function chargeRule(thresholdCents = DEFAULT_PRECHARGE_CENTS): string {
  const t = formatCents(thresholdCents);
  return `Runs over ${t} are charged when they start and refunded in full if they fail. Runs of ${t} or less are added to your balance after they succeed; the balance is charged within ${BALANCE_WINDOW_HOURS} hours or when it reaches your account's limit. Failed runs are never charged.`;
}

/** The sentence under one quote. */
export function quoteChargeSentence(
  amountCents: number,
  timing: ChargeTiming | undefined,
  balanceLimitCents?: number,
): string {
  const amount = formatCents(amountCents);
  if (timing === "before") {
    return `We charge ${amount} when the run starts and refund it in full if it fails.`;
  }
  const limit =
    balanceLimitCents !== undefined
      ? ` or when it reaches ${formatCents(balanceLimitCents)}`
      : "";
  return `We add ${amount} to your balance after it succeeds. Your balance is charged within ${BALANCE_WINDOW_HOURS} hours${limit}.`;
}
