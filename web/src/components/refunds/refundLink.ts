/**
 * Refund policy (owner 2026-11-07): people can ask for a refund and a
 * person decides, case by case. The account's danger zone links here so
 * someone deleting their account can ask about their unspent balance
 * first: Billing opens "Request a refund" with the balance picked.
 */

import { SITE_NAME } from "@/lib/site";

/** English (tests); the link reads refunds.section.reportSubject. */
export const REPORT_PROBLEM_SUBJECT = `${SITE_NAME}: report a problem`;

export const REFUND_REQUEST_HREF = "/account/billing?refund=balance";

/** ?refund=… in the address: "balance" picks the balance, anything else
 * just opens the form. Dropped so a reload doesn't reopen it; null when
 * it wasn't there. */
export function dropRefundParam(): "balance" | "open" | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const v = url.searchParams.get("refund");
  if (v === null) return null;
  url.searchParams.delete("refund");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  return v === "balance" ? "balance" : "open";
}
