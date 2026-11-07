/**
 * When we charge, in one place (S3D-19, S3D-21, S3D-45). Both methods: a
 * run quoted over the pre-charge threshold ($25) is charged when it starts
 * and refunded if it fails; a smaller run is charged after it's done. How
 * small charges are grouped is internal: the customer UI never says
 * "balance", "batch", "charged by", "pending" or names a limit. Each run
 * shows its price; a word is added only for Refunded, Not charged and
 * Payment needed.
 */

import type { BillingStatus, ChargeTiming, Conversion, GatewayLimits } from "@/lib/api/types";

import { formatCentsShort } from "@/components/steps/money";
import { EN, type Tr } from "@/lib/i18n/t";

/** The gateway's default; GET /v1/limits rates.precharge_threshold_cents
 * is authoritative. */
export const DEFAULT_PRECHARGE_CENTS = 2500;

export function prechargeThreshold(limits: GatewayLimits | null): number {
  return limits?.rates?.precharge_threshold_cents ?? DEFAULT_PRECHARGE_CENTS;
}

export const CHARGED_AT_START = "Charged when it starts. Refunded if it fails.";
export const CHARGED_AFTER = "Charged after it's done.";

/** Every paid run while deferred payments are off (BL-32, owner
 * 2026-11-07): paid as it starts, credit and balance first. Customer
 * pages say this instead of the after/before threshold rule. */
export const PAY_BEFORE = "You pay before a run starts. Your credit and balance are used first.";

/** The public /pricing page's version: S3D-45 keeps "balance" off it. */
export const PAY_BEFORE_PUBLIC = "You pay before a run starts.";

/** Prices round the video up to whole minutes (owner 2026-11-04; the
 * gateway's quote carries billable_minutes). */
export const ROUNDED_UP_LINE = "Each started minute counts as a full minute.";

/** The lines above in the reader's language. */
export function chargedAtStart(t: Tr = EN): string {
  return t("quote.charge.atStart");
}
export function chargedAfter(t: Tr = EN): string {
  return t("quote.charge.after");
}
export function payBefore(t: Tr = EN): string {
  return t("quote.charge.payBefore");
}
export function payBeforePublic(t: Tr = EN): string {
  return t("quote.charge.payBeforePublic");
}
export function roundedUpLine(t: Tr = EN): string {
  return t("quote.charge.roundedUp");
}

/** The general rule, for onboarding and Account. */
export function chargeRule(thresholdCents = DEFAULT_PRECHARGE_CENTS, t: Tr = EN): string {
  return t("quote.charge.rule", { amount: formatCentsShort(thresholdCents, t) });
}

/** The line under one quote. */
export function quoteChargeSentence(timing: ChargeTiming | undefined, t: Tr = EN): string {
  return timing === "before" ? chargedAtStart(t) : chargedAfter(t);
}

/** The one word a run's price may carry (S3D-21): Refunded · Not
 * charged · Payment needed; null otherwise (the price alone). */
export function paymentStatus(c: Conversion, t: Tr = EN): string | null {
  switch (c.billing?.status) {
    case "refund_pending":
    case "refunded":
      return t("quote.payment.refunded");
    case "not_charged":
      return t("quote.payment.notCharged");
    case "charge_failed":
      return t("quote.payment.needed");
  }
  if (c.state === "failed" || c.state === "canceled" || c.state === "expired") {
    return t("quote.payment.notCharged");
  }
  return null;
}

/** A failed charge, in words. */
export const PAYMENT_NEEDED = "Payment needed: update your payment method";

export function paymentNeeded(t: Tr = EN): string {
  return t("quote.payment.update");
}

/** The "?" beside a Make 3D price (S3D-23): when it's charged and when a
 * cancel costs nothing. */
export function cancelRule(
  timing: ChargeTiming | undefined,
  thresholdCents = DEFAULT_PRECHARGE_CENTS,
  t: Tr = EN,
): string {
  return timing === "before"
    ? // gateway 00166: deferred payments are off, every paid run is charged as it starts
      t("quote.charge.cancelBefore")
    : t("quote.charge.cancelAfter", { amount: formatCentsShort(thresholdCents, t) });
}

/** S3D-35: what the account still owes (failed charges waiting to be
 * paid), in cents; 0 when nothing is outstanding or status is unknown. */
export function outstandingCents(
  status: (Pick<BillingStatus, "unpaid"> & Partial<Pick<BillingStatus, "outstanding">>) | null,
): number {
  // spec v6 F: the gateway's sum when it sends one
  if (status?.outstanding) return status.outstanding.amount_cents;
  return (status?.unpaid ?? []).reduce((sum, u) => sum + u.amount_cents, 0);
}

/** S3D-35: the label every download (or play) button carries while a
 * payment is outstanding — playing the file is the same access. */
export function payToDownload(cents: number, verb: "download" | "play" = "download", t: Tr = EN): string {
  const amount = formatCentsShort(cents, t);
  return verb === "play" ? t("quote.payment.payToPlay", { amount }) : t("quote.payment.payToDownload", { amount });
}
