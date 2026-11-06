"use client";

/**
 * Pro's monthly usage credit (owner 2026-11-07, gateway 00159): what's left
 * this month and when it expires, from GET /v1/billing pro_credit. Shown
 * like a Business or Studio plan's usage (PlanCard, BalanceCard): a line,
 * the expiry, a bar. Nothing when the account has none, or when it isn't
 * granted to this account (a transferred purchase).
 */

import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";
import type { ProCreditStatus } from "@/lib/api/types";
import { useBilling } from "@/lib/billing";

/** "1 Dec": the day after the period ends is when a new credit comes, so
 * the credit expires at period_end. */
function dayMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** This month's Pro credit when the account has one granted. */
export function useProCredit(): ProCreditStatus | null {
  const c = useBilling().status?.pro_credit;
  return c && c.granted ? c : null;
}


/** The left / of / expiry block with its bar. */
export function ProCreditLeft({ credit }: { credit: ProCreditStatus }): JSX.Element {
  const total = credit.cents_per_month;
  const used = total > 0 ? Math.min(1, Math.max(0, (total - credit.left_cents) / total)) : 0;
  return (
    <div data-testid="pro-credit" className="flex flex-col gap-1.5">
      <p data-testid="pro-credit-left" className="text-sm text-fg tabular-nums">
        {formatCents(credit.left_cents)} of {formatCents(total)} Pro credit left this month
      </p>
      <p data-testid="pro-credit-expires" className="text-xs text-fg-muted">
        Expires on {dayMonth(credit.period_end)} and isn&apos;t paid out.
      </p>
      <span aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${used * 100}%` }} />
      </span>
    </div>
  );
}

/** Billing: the Pro credit card, for any Pro (web or App Store). */
export function ProCreditCard(): JSX.Element | null {
  const credit = useProCredit();
  if (!credit) return null;
  return (
    <section
      data-testid="pro-credit-card"
      aria-labelledby="pro-credit-title"
      className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-5"
    >
      <h2 id="pro-credit-title" className="text-sm font-semibold text-fg">
        Pro credit
      </h2>
      <ProCreditLeft credit={credit} />
      <p className="text-xs text-fg-muted">
        Used before your balance on every run.{credit.trial ? " Your free trial includes it." : ""}
      </p>
    </section>
  );
}
