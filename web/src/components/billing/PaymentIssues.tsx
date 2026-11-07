"use client";

/**
 * Payments that didn't go through (owner 2026-11-07, D), from GET
 * /v1/billing:
 *
 * - a plan's renewal past due (plan.past_due): "Your Business payment
 *   didn't go through. Pay now to keep your plan." (the bank wants a
 *   confirmation: "Confirm your payment with your bank."). The plan's
 *   benefits continue meanwhile, so nothing here says they stopped.
 * - an auto-reload or what the account owes, being retried
 *   (prepaid.auto_reload.retry, dues_retry): "We'll try again on Nov 9."
 *   while pending, "Payment failed." once final, with the gateway's
 *   customer-safe reason under it (last_error_message).
 *
 * Each has Pay now: the pay page its pay_url names (/pay/{token}).
 */

import { AlertCircleIcon } from "lucide-react";
import type { JSX } from "react";

import { prepaidOf, type BillingStatus, type PaymentRetry } from "@/lib/api/types";
import { useBilling } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

export interface PaymentIssue {
  id: "past_due" | "reload_retry" | "dues_retry";
  text: string;
  /** the gateway's customer-safe reason (last_error_message) */
  detail: string | null;
  payUrl: string | null;
}

function day(iso: string | null | undefined, t: Tr): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(t.intl, { month: "short", day: "numeric" });
}

function retryText(r: PaymentRetry, t: Tr): string | null {
  if (r.state === "pending") {
    const on = day(r.next_attempt_at, t);
    return on ? t("billing.issues.retryOn", { date: on }) : t("billing.issues.retrying");
  }
  if (r.state === "final") return t("billing.issues.failed");
  return null;
}

/** What to show, in order: the plan first, then retries. */
export function paymentIssues(status: BillingStatus | null, t: Tr = EN): PaymentIssue[] {
  if (!status) return [];
  const out: PaymentIssue[] = [];
  const plan = status.plan;
  if (plan?.past_due) {
    const name = plan.name ?? (plan.plan === "pro" ? "Pro" : plan.plan.charAt(0).toUpperCase() + plan.plan.slice(1));
    out.push({
      id: "past_due",
      text: plan.action_required ? t("billing.issues.pastDueConfirm", { plan: name }) : t("billing.issues.pastDue", { plan: name }),
      detail: null,
      payUrl: plan.pay_url ?? null,
    });
  }
  const reload = prepaidOf(status)?.auto_reload?.retry;
  const reloadText = reload ? retryText(reload, t) : null;
  if (reload && reloadText) out.push({ id: "reload_retry", text: reloadText, detail: reload.last_error_message ?? null, payUrl: reload.pay_url ?? null });
  const dues = status.dues_retry;
  const duesText = dues ? retryText(dues, t) : null;
  if (dues && duesText) out.push({ id: "dues_retry", text: duesText, detail: dues.last_error_message ?? null, payUrl: dues.pay_url ?? null });
  return out;
}

/** The banners, where the account banner shows (projects) and on Billing. */
export function PaymentIssues(): JSX.Element | null {
  const t = useT();
  const { status } = useBilling();
  const issues = paymentIssues(status, t);
  if (issues.length === 0) return null;
  return (
    <div className="flex flex-col">
      {issues.map((i) => (
        <div
          key={i.id}
          data-testid={`payment-issue-${i.id}`}
          role="status"
          className="border-b border-amber-900/50 bg-amber-950/30 px-4 py-2.5"
        >
          <div className="mx-auto flex w-full max-w-7xl items-center gap-3">
            <AlertCircleIcon className="size-4 shrink-0 text-amber-300" aria-hidden />
            <p className="min-w-0 flex-1 text-sm text-amber-100">
              {i.text}
              {i.detail ? (
                <span data-testid={`payment-issue-detail-${i.id}`} className="block text-xs text-amber-200/80">
                  {i.detail}
                </span>
              ) : null}
            </p>
            {i.payUrl ? (
              <a
                href={i.payUrl}
                data-testid={`payment-issue-pay-${i.id}`}
                className="shrink-0 rounded-md bg-amber-300 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-amber-200"
              >
                {t("billing.issues.payNow")}
              </a>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
