/**
 * Payment screens' copy, final per spec v6 G2 (P1–P14). One place, so the
 * screens and the tests agree word for word. No processor or routing names.
 */

import { formatCents } from "@/components/steps/money";

export const CHARGED_IN_USD = "Charged in US dollars.";
export const WITHDRAWAL_LINE =
  "It starts right away. You agree that you lose your right to cancel once it's done.";
export const REFUNDED_IF_FAILS = "Refunded in full if it fails.";
export const SAVE_LINE = "Saved for your next runs. You can remove it in Billing.";
export const OR_PAY_ANOTHER_WAY = "or pay another way";

// P1 states
export const PAYING = "Paying…";
export const WAITING_CONFIRM =
  "Waiting for your payment to be confirmed. You can close this. Your 3D video starts as soon as it's through.";
export const DECLINED = "Your payment method was declined. Try another way to pay.";
export const TOO_MANY = "Too many attempts. Try a wallet or try again later.";
export const PAID_STARTING = "Paid. Starting your 3D…";
export const ALREADY_PAID = "This is already paid.";
export const EXPIRED_RUN = "This payment expired. Start again when you're ready.";
export const UNAVAILABLE = "Payment isn't available in this region yet.";
export const ALIPAY_LINE = "You'll finish in Alipay, then come back here.";

// P2
export const SETTLE_TITLE = "Pay for your last runs";
export const SETTLE_FOOT = "Your downloads come back as soon as it's paid.";
export const CONFIRMING = "Confirming your payment…";
export const SETTLED = "Paid. Your downloads are back.";
export const ALREADY_SETTLED = "Already paid. Your downloads are back.";
export const EXPIRED = "This payment expired.";

// P3
export const CONFIRM_TITLE = "Confirm your payment";
export const BANK_WANTS = "Your bank wants to confirm this payment.";
export function declinedChoose(label: string): string {
  return `Your ${label} was declined. Choose another way to pay.`;
}

// P9
export const PAYMENT_PROBLEM = "There's a problem with your last payment.";
export const UNDER_REVIEW = "We're checking a payment on your account.";
export const DISPUTED_ROW = "Unavailable while disputed with your bank";

// P12
export const WAITING_FOR_PAYMENT = "Waiting for payment…";
export const FINISH_PAYMENT = "Finish payment";

// P14
export const PAUSED_REVIEW = "Paused while we check a payment.";
export const POP_AFTER =
  "Charged to your default payment method when it's ready. Not charged if it fails. It starts right away. You agree that you lose your right to cancel once it's done.";
export const POP_PRECHARGE =
  "Charged to your default payment method when you start it. Cancel while it waits in line, or in its first minute, for a full refund. It starts right away. You agree that you lose your right to cancel once it's done.";
export const POP_SHEET = "You'll choose how to pay next. Refunded in full if it fails.";

/** "Pay $7.25 to continue" (run buttons while the account owes). */
export function payToContinue(cents: number): string {
  return `Pay ${formatCents(cents)} to continue`;
}

/** "Pay $1.00 and start". */
export function payAndStart(cents: number): string {
  return `Pay ${formatCents(cents)} and start`;
}

/** "Paid $7.25. One more payment is waiting." */
export function paidMoreWaiting(cents: number): string {
  return `Paid ${formatCents(cents)}. One more payment is waiting.`;
}

/** "{n} runs · charged after they were done" */
export function settleSubtitle(runs: number): string {
  return `${runs} ${runs === 1 ? "run" : "runs"} · charged after ${runs === 1 ? "it was" : "they were"} done`;
}

// ------------------------------------------------- spec v7: the balance

export const PAID_FROM_BALANCE = "Paid from your balance";
export const SPEND_LIMIT_REACHED = "You've reached your monthly spend limit.";
export const TOPUP_SMALL_PRINT =
  "Unspent funds can be refunded within 14 days. Your balance expires 12 months after your last top-up.";
export const TOPUP_MIN = "The minimum is $10.";
/** P2 from the balance, when it no longer covers it (not in the spec's copy) */
export const BALANCE_SETTLE_FAILED = "Your balance doesn't cover it any more. Pay another way.";
/** 00081: 403 payment_method_blocked on runs and top-ups */
export const PAYMENT_METHOD_BLOCKED = "This payment method can't be used. Add another one.";
/** 00081: 403 deletion_pending while the account waits to be deleted */
export const DELETION_PENDING_BLOCK = "Your account is being deleted.";
export const TOPUP_DAILY = "You've reached today's limit. Try again tomorrow.";

/** 00083: topup_daily_cap with what's left today */
export function topupDayLeft(cents: number): string {
  return cents > 0 ? `You can add up to ${formatCents(cents)} more today.` : TOPUP_DAILY;
}

/** 00083: auto_reload_blocked, one line per reason */
export const AUTO_RELOAD_BLOCKED: Record<string, string> = {
  under_review: "Auto-reload can't be turned on while we check a payment.",
  dispute: "Auto-reload can't be turned on while a bank dispute is open.",
  payment_failed: "Auto-reload can't be turned on until a failed payment is paid.",
  deletion_pending: "Auto-reload can't be turned on while your account is being deleted.",
};

/** "Paid from your balance. We'll add $25.00 first." */
export function paidFromBalanceReload(reloadCents: number): string {
  return `Paid from your balance. We'll add ${formatCents(reloadCents)} first.`;
}

/** P14 "?" for balance runs. */
export function popBalance(amountCents: number): string {
  return `We reserve ${formatCents(amountCents)} from your balance when it starts and take only the final cost, never more. Failed runs cost nothing. It starts right away. You agree that you lose your right to cancel once it's done.`;
}

/** "You can add up to $500 at a time." / first top-up */
export function topupMax(maxCents: number, first: boolean): string {
  return first
    ? `You can add up to ${formatCents(maxCents).replace(/\.00$/, "")} for your first top-up.`
    : `You can add up to ${formatCents(maxCents).replace(/\.00$/, "")} at a time.`;
}

/** "Added $25.00. Your balance is $28.20." */
export function topupDone(added: number, balance: number): string {
  return `Added ${formatCents(added)}. Your balance is ${formatCents(balance)}.`;
}

/** P18 consent line */
export function reloadConsent(method: string | null, addCents: number, belowCents: number): string {
  return `We'll charge your default payment method${method ? ` (${method})` : ""} ${formatCents(addCents)} whenever your balance drops below ${formatCents(belowCents)}. If it's declined, we try your others.`;
}

/** Owner 2026-11-04: outputs without a Business or Studio plan are for
 * personal use (Terms "Using your 3D outputs"). */
export const PERSONAL_USE_LINE =
  "For personal use. Commercial use comes with Business and Studio plans.";
