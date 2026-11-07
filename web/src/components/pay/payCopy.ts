/**
 * Payment screens' copy, final per spec v6 G2 (P1–P14). One place, so the
 * screens and the tests agree word for word. No processor or routing names.
 *
 * The words live in messages/<locale>.json (pay.copy.*, balance.copy.*):
 * the constants are the English ones (for code without a translator and
 * the tests); screens read t("pay.copy.…"), and the helpers take a
 * translator as their last argument.
 */

import { formatCents, formatCentsShort } from "@/components/steps/money";
import { EN, type Tr } from "@/lib/i18n/t";

export const CHARGED_IN_USD = EN("pay.copy.chargedInUsd");
export const WITHDRAWAL_LINE = EN("pay.copy.withdrawal");
export const REFUNDED_IF_FAILS = EN("pay.copy.refundedIfFails");
export const SAVE_LINE = EN("pay.copy.saveLine");
export const OR_PAY_ANOTHER_WAY = EN("pay.copy.orPayAnotherWay");

// P1 states
export const PAYING = EN("pay.copy.paying");
export const WAITING_CONFIRM = EN("pay.copy.waitingConfirm");
export const DECLINED = EN("pay.copy.declined");
export const TOO_MANY = EN("pay.copy.tooMany");
export const PAID_STARTING = EN("pay.copy.paidStarting");
export const ALREADY_PAID = EN("pay.copy.alreadyPaid");
export const EXPIRED_RUN = EN("pay.copy.expiredRun");
export const UNAVAILABLE = EN("pay.copy.unavailable");
export const ALIPAY_LINE = EN("pay.copy.alipayLine");

// P2
export const SETTLE_TITLE = EN("pay.copy.settleTitle");
export const SETTLE_FOOT = EN("pay.copy.settleFoot");
export const CONFIRMING = EN("pay.copy.confirming");
export const SETTLED = EN("pay.copy.settled");
export const ALREADY_SETTLED = EN("pay.copy.alreadySettled");
export const EXPIRED = EN("pay.copy.expired");

// P3
export const CONFIRM_TITLE = EN("pay.copy.confirmTitle");
export const BANK_WANTS = EN("pay.copy.bankWants");
export function declinedChoose(label: string, t: Tr = EN): string {
  return t("pay.copy.declinedChoose", { label });
}

// P9
export const PAYMENT_PROBLEM = EN("pay.copy.paymentProblem");
export const UNDER_REVIEW = EN("pay.copy.underReview");
export const DISPUTED_ROW = EN("pay.copy.disputedRow");

// P12
export const WAITING_FOR_PAYMENT = EN("pay.copy.waitingForPayment");
export const FINISH_PAYMENT = EN("pay.copy.finishPayment");

// P14
export const PAUSED_REVIEW = EN("pay.copy.pausedReview");
export const POP_AFTER = EN("pay.copy.popAfter");
export const POP_PRECHARGE = EN("pay.copy.popPrecharge");
export const POP_SHEET = EN("pay.copy.popSheet");

/** "Pay $7.25 to continue" (run buttons while the account owes). */
export function payToContinue(cents: number, t: Tr = EN): string {
  return t("pay.copy.payToContinue", { amount: formatCents(cents, t) });
}

/** "Pay $1.00 and start". */
export function payAndStart(cents: number, t: Tr = EN): string {
  return t("pay.copy.payAndStart", { amount: formatCents(cents, t) });
}

/** "Paid $7.25. One more payment is waiting." */
export function paidMoreWaiting(cents: number, t: Tr = EN): string {
  return t("pay.copy.paidMoreWaiting", { amount: formatCents(cents, t) });
}

/** "{n} runs · charged after they were done" */
export function settleSubtitle(runs: number, t: Tr = EN): string {
  return t("pay.copy.settleSubtitle", { count: runs });
}

// ------------------------------------------------- spec v7: the balance

export const PAID_FROM_BALANCE = EN("balance.copy.paidFromBalance");
export const SPEND_LIMIT_REACHED = EN("balance.copy.spendLimitReached");
export const TOPUP_SMALL_PRINT = EN("balance.copy.topupSmallPrint");
/** "The minimum is $10." */
export function topupMin(t: Tr = EN): string {
  return t("balance.copy.topupMin", { amount: formatCentsShort(1000, t) });
}
export const TOPUP_MIN = topupMin();
/** P2 from the balance, when it no longer covers it (not in the spec's copy) */
export const BALANCE_SETTLE_FAILED = EN("balance.copy.settleFailed");
/** 00081: 403 payment_method_blocked on runs and top-ups */
export const PAYMENT_METHOD_BLOCKED = EN("balance.copy.paymentMethodBlocked");
/** 00081: 403 deletion_pending while the account waits to be deleted */
export const DELETION_PENDING_BLOCK = EN("balance.copy.deletionPending");
export const TOPUP_DAILY = EN("balance.copy.topupDaily");

/** 00083: topup_daily_cap with what's left today */
export function topupDayLeft(cents: number, t: Tr = EN): string {
  return cents > 0
    ? t("balance.copy.topupDayLeft", { amount: formatCents(cents, t) })
    : t("balance.copy.topupDaily");
}

const BLOCKED_KEY: Record<string, string> = {
  under_review: "underReview",
  dispute: "dispute",
  payment_failed: "paymentFailed",
  deletion_pending: "deletionPending",
};

/** 00083: auto_reload_blocked, one line per reason (under_review for
 * a reason it doesn't know) */
export function autoReloadBlocked(reason: string, t: Tr = EN): string {
  return t(`balance.copy.autoReloadBlocked.${BLOCKED_KEY[reason] ?? "underReview"}`);
}

/** 00083: auto_reload_blocked, one line per reason (English) */
export const AUTO_RELOAD_BLOCKED: Record<string, string> = Object.fromEntries(
  Object.keys(BLOCKED_KEY).map((r) => [r, autoReloadBlocked(r)]),
);

/** "Paid from your balance. We'll add $25.00 first." */
export function paidFromBalanceReload(reloadCents: number, t: Tr = EN): string {
  return t("balance.copy.paidFromBalanceReload", { amount: formatCents(reloadCents, t) });
}

/** P14 "?" for balance runs. */
export function popBalance(amountCents: number, t: Tr = EN): string {
  return t("balance.copy.popBalance", { amount: formatCents(amountCents, t) });
}

/** "You can add up to $500 at a time." / first top-up */
export function topupMax(maxCents: number, first: boolean, t: Tr = EN): string {
  const amount = formatCentsShort(maxCents, t);
  return first
    ? t("balance.copy.topupMaxFirst", { amount })
    : t("balance.copy.topupMax", { amount });
}

/** "Added $25.00. Your balance is $28.20." */
export function topupDone(added: number, balance: number, t: Tr = EN): string {
  return t("balance.copy.topupDone", { added: formatCents(added, t), balance: formatCents(balance, t) });
}

/** P18 consent line */
export function reloadConsent(method: string | null, addCents: number, belowCents: number, t: Tr = EN): string {
  const values = { method, add: formatCents(addCents, t), below: formatCents(belowCents, t) };
  return method
    ? t("balance.copy.reloadConsentWithMethod", values)
    : t("balance.copy.reloadConsent", values);
}

/** Owner 2026-11-04: outputs without a Business or Studio plan are for
 * personal use (Terms "Using your 3D outputs"). */
export const PERSONAL_USE_LINE = EN("pay.copy.personalUse");
