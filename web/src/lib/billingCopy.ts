/**
 * When we charge, in one place (S3D-19, S3D-21, S3D-45). Both methods: a
 * run quoted over the pre-charge threshold ($25) is charged when it starts
 * and refunded if it fails; a smaller run is charged after it's done. How
 * small charges are grouped is internal: the customer UI never says
 * "balance", "batch", "charged by", "pending" or names a limit. Each run
 * shows its price; a word is added only for Refunded, Not charged and
 * Payment needed.
 */

import type { ChargeTiming, Conversion, GatewayLimits } from "@/lib/api/types";

import { formatCentsShort } from "@/components/steps/money";

/** The gateway's default; GET /v1/limits rates.precharge_threshold_cents
 * is authoritative. */
export const DEFAULT_PRECHARGE_CENTS = 2500;

export function prechargeThreshold(limits: GatewayLimits | null): number {
  return limits?.rates?.precharge_threshold_cents ?? DEFAULT_PRECHARGE_CENTS;
}

export const CHARGED_AT_START = "Charged when it starts. Refunded if it fails.";
export const CHARGED_AFTER = "Charged after it's done.";

/** The general rule, for onboarding and Account. */
export function chargeRule(thresholdCents = DEFAULT_PRECHARGE_CENTS): string {
  const t = formatCentsShort(thresholdCents);
  return `Runs over ${t}: ${CHARGED_AT_START.toLowerCase()} Runs of ${t} or less: ${CHARGED_AFTER.toLowerCase()} Failed runs cost nothing.`;
}

/** The line under one quote. */
export function quoteChargeSentence(timing: ChargeTiming | undefined): string {
  return timing === "before" ? CHARGED_AT_START : CHARGED_AFTER;
}

/** The one word a run's price may carry (S3D-21): Refunded · Not
 * charged · Payment needed; null otherwise (the price alone). */
export function paymentStatus(c: Conversion): string | null {
  switch (c.billing?.status) {
    case "refund_pending":
    case "refunded":
      return "Refunded";
    case "not_charged":
      return "Not charged";
    case "charge_failed":
      return "Payment needed";
  }
  if (c.state === "failed" || c.state === "canceled" || c.state === "expired") {
    return "Not charged";
  }
  return null;
}

/** A failed charge, in words. */
export const PAYMENT_NEEDED = "Payment needed: update your card";

/** The "?" beside a Make 3D price (S3D-23): when it's charged and when a
 * cancel costs nothing. */
export function cancelRule(
  timing: ChargeTiming | undefined,
  thresholdCents = DEFAULT_PRECHARGE_CENTS,
): string {
  const t = formatCentsShort(thresholdCents);
  return timing === "before"
    ? `Runs over ${t} are charged when you start them. Cancel any time while it waits in line, or in its first minute, for a full refund.`
    : `Runs of ${t} or less are charged after they're done. Cancel any time while it waits in line, or in its first minute, and you pay nothing.`;
}
