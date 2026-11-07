/**
 * Run states in customer words (S3D-33), derived from the gateway's state,
 * the GPU wait and the payment: Waiting in line · Making your 3D · Ready ·
 * Failed, not charged · Failed, refunded $X · Cancelled, not charged ·
 * Ready, payment needed. The wire states ("paid" before anything is paid,
 * "expired") never reach the screen.
 */

import type { Conversion } from "@/lib/api/types";
import { EN, type Tr } from "@/lib/i18n/t";

import { formatCents, localAmount } from "./money";

export type RunTone = "waiting" | "working" | "ready" | "attention" | "stopped";

export interface RunStatus {
  label: string;
  tone: RunTone;
}

/** The refunded amount of a pre-charged run, when it was refunded. */
function refunded(c: Conversion, t: Tr): string | null {
  const s = c.billing?.status;
  if (s !== "refunded" && s !== "refund_pending") return null;
  // owner 2026-11-07: a refund goes back in the currency the card paid
  return localAmount(c.presentment, t) ?? formatCents(c.billing?.charged_cents ?? c.quote.amount_cents, t);
}

export function runStatus(c: Conversion, t: Tr = EN): RunStatus {
  switch (c.state) {
    case "created":
      return { label: t("runs.status.confirmingPayment"), tone: "waiting" };
    case "paid":
      return { label: t("runs.status.waitingInLine"), tone: "waiting" };
    case "processing":
      return c.waiting_for_gpu
        ? { label: t("runs.status.waitingInLine"), tone: "waiting" }
        : { label: t("runs.status.making"), tone: "working" };
    case "succeeded":
      return c.billing?.status === "charge_failed"
        ? { label: t("runs.status.readyPaymentNeeded"), tone: "attention" }
        : { label: t("runs.status.ready"), tone: "ready" };
    case "failed": {
      const r = refunded(c, t);
      return {
        label: r ? t("runs.status.failedRefunded", { amount: r }) : t("runs.status.failedNotCharged"),
        tone: "attention",
      };
    }
    case "canceled": {
      const r = refunded(c, t);
      return {
        label: r ? t("runs.status.cancelledRefunded", { amount: r }) : t("runs.status.cancelledNotCharged"),
        tone: "stopped",
      };
    }
    case "expired":
      return { label: t("runs.status.expiredNotCharged"), tone: "stopped" };
  }
}

/** Waiting copy (S3D-34). */
export function waitingInLineNote(t: Tr = EN): string {
  return t("runs.status.waitingNote");
}

/** Waiting copy in English (kept for older callers). */
export const WAITING_IN_LINE_NOTE = waitingInLineNote();

/** The state in one word or two, for the Files list (screen 09): the
 * money word sits beside the price (lib/billingCopy paymentStatus). */
export function runStateShort(c: Conversion, t: Tr = EN): string {
  switch (c.state) {
    case "created":
      return t("runs.status.confirmingPayment");
    case "paid":
      return t("runs.status.waitingInLine");
    case "processing":
      return c.waiting_for_gpu ? t("runs.status.waitingInLine") : t("runs.status.making");
    case "succeeded":
      return t("runs.status.ready");
    case "failed":
      return t("runs.status.short.failed");
    case "canceled":
      return t("runs.status.short.cancelled");
    case "expired":
      return t("runs.status.short.expired");
  }
}
