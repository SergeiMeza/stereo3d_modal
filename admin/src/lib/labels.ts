import type { Tone } from "@/components/common";

export function typeTone(type: string): Tone {
  switch (type) {
    case "dispute":
      return "red";
    case "efw":
      return "amber";
    case "refund":
    case "balance_refund":
      return "blue";
    case "waive":
      return "violet";
    default:
      return "plain";
  }
}

export function typeLabel(type: string): string {
  switch (type) {
    case "efw":
      return "EFW";
    case "balance_refund":
      return "Balance refund";
    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

export function statusTone(status: string, result?: string): Tone {
  if (status === "closed") return result === "dispute_lost" || result === "denied" ? "muted" : "plain";
  switch (status) {
    case "open":
      return "green";
    case "waiting_on_customer":
    case "waiting_for_run":
    case "refund_pending":
      return "blue";
    case "decided":
      return "violet";
    default:
      return "plain";
  }
}

export function statusLabel(status: string, result?: string): string {
  const map: Record<string, string> = {
    waiting_for_run: "Waiting for the run",
    open: "Open",
    waiting_on_customer: "Waiting on customer",
    decided: "Decided",
    refund_pending: "Refund pending",
    closed: "Closed",
  };
  const s = map[status] ?? status.replace(/_/g, " ");
  return status === "closed" && result ? `${s} · ${result.replace(/_/g, " ")}` : s;
}

export const CASE_TYPES = ["refund", "dispute", "efw", "support", "waive", "balance_refund"];

export const REASONS = [
  "run_failed_undelivered",
  "cancel_undelivered",
  "cancelled_by_us",
  "deletion_undelivered",
  "late_or_duplicate",
  "partial_failure",
  "delivered_run",
  "quality_complaint",
  "support_request",
  "efw",
  "dispute",
  "refund_failed",
  "dashboard_unassigned",
  "unpaid_run",
  "topup_withdrawal",
  "closure_balance",
];
