/**
 * Run states in customer words (S3D-33), derived from the gateway's state,
 * the GPU wait and the payment: Waiting in line · Making your 3D · Ready ·
 * Failed, not charged · Failed, refunded $X · Cancelled, not charged ·
 * Ready, payment needed. The wire states ("paid" before anything is paid,
 * "expired") never reach the screen.
 */

import type { Conversion } from "@/lib/api/types";

import { formatCents } from "./money";

export type RunTone = "waiting" | "working" | "ready" | "attention" | "stopped";

export interface RunStatus {
  label: string;
  tone: RunTone;
}

/** The refunded amount of a pre-charged run, when it was refunded. */
function refunded(c: Conversion): string | null {
  const s = c.billing?.status;
  if (s !== "refunded" && s !== "refund_pending") return null;
  return formatCents(c.billing?.charged_cents ?? c.quote.amount_cents);
}

export function runStatus(c: Conversion): RunStatus {
  switch (c.state) {
    case "created":
      return { label: "Confirming payment", tone: "waiting" };
    case "paid":
      return { label: "Waiting in line", tone: "waiting" };
    case "processing":
      return c.waiting_for_gpu
        ? { label: "Waiting in line", tone: "waiting" }
        : { label: "Making your 3D", tone: "working" };
    case "succeeded":
      return c.billing?.status === "charge_failed"
        ? { label: "Ready, payment needed", tone: "attention" }
        : { label: "Ready", tone: "ready" };
    case "failed": {
      const r = refunded(c);
      return {
        label: r ? `Failed, refunded ${r}` : "Failed, not charged",
        tone: "attention",
      };
    }
    case "canceled": {
      const r = refunded(c);
      return {
        label: r ? `Cancelled, refunded ${r}` : "Cancelled, not charged",
        tone: "stopped",
      };
    }
    case "expired":
      return { label: "Didn't start, not charged", tone: "stopped" };
  }
}

/** Waiting copy (S3D-34). */
export const WAITING_IN_LINE_NOTE =
  "Starts as soon as a machine is free, usually within minutes. The price stays the same.";
