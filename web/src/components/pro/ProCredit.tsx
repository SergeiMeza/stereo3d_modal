"use client";

/**
 * Pro's usage credit (owner 2026-11-07, gateway 00166): given once, when
 * someone joins Pro or first signs in on the web with Pro from the app,
 * from GET /v1/billing pro_credit. What's left and the use-by day; nothing
 * once it's spent or past its day, or when it isn't granted to this
 * account (a transferred purchase).
 */

import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";
import type { ProCreditStatus } from "@/lib/api/types";
import { useBilling } from "@/lib/billing";

/** "7 Dec" */
function dayMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** The account's Pro credit while some is left to use. */
export function liveProCredit(c: ProCreditStatus | null | undefined, now = Date.now()): ProCreditStatus | null {
  if (!c || !c.granted || c.left_cents <= 0) return null;
  if (c.expires_at && new Date(c.expires_at).getTime() <= now) return null;
  return c;
}

export function useProCredit(): ProCreditStatus | null {
  return liveProCredit(useBilling().status?.pro_credit);
}

/** "$12.40 of $20.00 Pro credit left · use by 7 Dec", with a bar. */
export function ProCreditLeft({ credit }: { credit: ProCreditStatus }): JSX.Element {
  const total = credit.cents;
  const used = total > 0 ? Math.min(1, Math.max(0, (total - credit.left_cents) / total)) : 0;
  return (
    <div data-testid="pro-credit" className="flex flex-col gap-1.5">
      <p data-testid="pro-credit-left" className="text-sm text-fg tabular-nums">
        {formatCents(credit.left_cents)} of {formatCents(total)} Pro credit left · use by {dayMonth(credit.expires_at)}
      </p>
      <p data-testid="pro-credit-expires" className="text-xs text-fg-muted">
        It isn&apos;t paid out.
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
