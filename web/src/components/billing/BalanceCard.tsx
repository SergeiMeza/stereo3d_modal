"use client";

/**
 * P10 Balance (spec v7 §N, mock p10/p10g): the prepaid balance at the top
 * of Billing — the amount, what's reserved, when it expires, Add funds
 * (P17), and the Auto-reload (P18), Monthly spend limit and Balance alert
 * (P19) rows.
 */

import { proCreditLine } from "@/components/pro/ProCredit";
import { PlusIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { useBalanceDialogs } from "@/components/pay/BalanceDialogs";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { isTeamPlan, prepaidOf } from "@/lib/api/types";
import type { AccountPlan, BalanceSummary } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "5 Dec" */
function dayMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Owner 2026-11-05: the Balance is the prepaid top-ups that keep; a
 * plan's usage credit (it doesn't carry over) is its own line, and so is
 * Pro's monthly credit. The gateway's prepaid_cents when it sends it, else
 * the balance less the credit left. */
export function prepaidCents(
  b: BalanceSummary,
  plan: AccountPlan | null | undefined,
  proCreditLeft = 0,
): number {
  if (typeof b.prepaid_cents === "number") return b.prepaid_cents;
  // owner 2026-11-07: Pro's credit counts like a plan's (only one applies)
  const credit = isTeamPlan(plan) ? (plan.credit_left_cents ?? 0) : proCreditLeft;
  return Math.max(b.balance_cents - credit, 0);
}

/** The prepaid part on hold, and when the prepaid money expires: the
 * gateway's prepaid fields when sent (a0efcfa), else the whole balance's. */
export function prepaidFrozenCents(b: BalanceSummary): number {
  return typeof b.prepaid_frozen_cents === "number" ? b.prepaid_frozen_cents : b.frozen_cents;
}

export function prepaidExpiresAt(b: BalanceSummary): string | null {
  return "prepaid_expires_at" in b ? (b.prepaid_expires_at ?? null) : (b.expires_at ?? null);
}

/** "Plan usage: $400 left this month · resets on 5 Dec" */
export function planUsageLine(plan: AccountPlan): string {
  const left = plan.credit_left_cents ?? plan.credit_cents ?? 0;
  const resets = plan.credit_resets_at ?? plan.current_period_end;
  return `Plan usage: ${formatCentsShort(left)} left this month${resets ? ` · resets on ${dayMonth(resets)}` : ""}`;
}

const PAUSED: Record<string, string> = {
  declined: "Auto-reload is paused because a payment didn't go through.",
  limit: "Auto-reload is paused: daily limit reached. It resumes tomorrow.",
};

export function BalanceCard(): JSX.Element | null {
  const { status } = useBilling();
  const gateway = useGateway();
  const billing = useBilling();
  const { openAddFunds, openAutoReload, openSpending } = useBalanceDialogs();
  if (status === null) {
    return <div data-testid="balance-loading" className="h-44 animate-pulse rounded-xl bg-surface-1" />;
  }
  const b = prepaidOf(status);
  if (!b) return null; // a gateway without the balance yet
  const ar = b.auto_reload;
  const paused = ar.enabled && ar.paused_reason ? (PAUSED[ar.paused_reason] ?? PAUSED.declined) : null;
  const limit = b.spend_limit_cents ?? null;
  const used = limit ? Math.min(1, b.month_spent_cents / limit) : 0;
  const plan = isTeamPlan(status.plan) ? status.plan : null;
  const proCredit = status.pro_credit?.granted ? status.pro_credit : null;
  const prepaid = prepaidCents(b, plan, proCredit?.left_cents ?? 0);
  const frozen = prepaidFrozenCents(b);
  const expires = prepaidExpiresAt(b);

  return (
    <section
      data-testid="balance-card"
      aria-labelledby="balance-title"
      className="flex flex-col rounded-xl border border-edge bg-surface-1"
    >
      <div className="flex flex-wrap items-end gap-4 p-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id="balance-title" className="text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
            Balance
          </h2>
          <p data-testid="balance-amount" className="text-4xl font-semibold tracking-tight text-fg tabular-nums">
            {formatCents(prepaid)}
          </p>
          {plan ? (
            <p data-testid="balance-plan-usage" className="text-xs text-fg-muted tabular-nums">
              {planUsageLine(plan)}
            </p>
          ) : null}
          {/* owner 2026-11-07: Pro's monthly credit, spent before the balance */}
          {proCredit ? (
            <p data-testid="balance-pro-credit" className="text-xs text-fg-muted tabular-nums">
              {proCreditLine(proCredit)}
            </p>
          ) : null}
          {b.held_cents > 0 ? (
            <p className="text-xs text-fg-muted tabular-nums">
              {formatCents(b.held_cents)} reserved for {b.held_runs ?? 1} {(b.held_runs ?? 1) === 1 ? "run" : "runs"} in progress
            </p>
          ) : null}
          {frozen > 0 ? (
            <p data-testid="balance-frozen" className="text-xs text-amber-200 tabular-nums">
              {formatCents(frozen)} on hold while a payment is reviewed.
            </p>
          ) : null}
          {b.expired && b.expires_at ? (
            <p className="text-xs text-fg-muted">Your balance expired on {longDate(b.expires_at)}.</p>
          ) : b.never_topped_up && prepaid === 0 ? (
            <p className="text-xs text-fg-muted">Add funds to pay for runs from your balance.</p>
          ) : expires ? (
            <p data-testid="balance-expires" className="text-xs text-fg-muted">
              Expires on {longDate(expires)} unless you add funds.
            </p>
          ) : null}
        </div>
        <Button size="lg" data-testid="balance-add-funds" onClick={openAddFunds}>
          <PlusIcon className="size-4" aria-hidden />
          Add funds
        </Button>
      </div>
      {paused ? (
        <div data-testid="reload-paused" className="flex flex-wrap items-center gap-3 border-t border-edge bg-amber-500/10 px-5 py-2.5 text-sm text-amber-100">
          <span className="min-w-0 flex-1">{paused}</span>
          {ar.paused_reason !== "limit" ? (
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={async () => {
                await gateway
                  .saveBalanceSettings({ auto_reload: { enabled: true, below_cents: ar.below_cents, add_cents: ar.add_cents } })
                  .catch(() => {});
                void billing.refresh();
              }}
            >
              Turn back on
            </button>
          ) : null}
        </div>
      ) : null}
      <SettingRow
        label="Auto-reload"
        value={ar.enabled ? `Below ${formatCents(ar.below_cents)}, add ${formatCents(ar.add_cents)}` : "Off"}
        action={ar.enabled ? "Edit" : "Set up"}
        onClick={openAutoReload}
      />
      <SettingRow
        label="Monthly spend limit"
        value={
          limit ? (
            <span className="flex items-center gap-3">
              {formatCents(limit).replace(/\.00$/, "")} a month · {formatCents(b.month_spent_cents)} used
              <span aria-hidden className="hidden h-1 w-28 overflow-hidden rounded-full bg-surface-2 sm:block">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${used * 100}%` }} />
              </span>
            </span>
          ) : (
            "None"
          )
        }
        action={limit ? "Edit" : "Set"}
        onClick={openSpending}
      />
      <SettingRow
        label="Balance alert"
        value={`Below ${formatCents(b.low_balance_cents)}`}
        action="Edit"
        onClick={openSpending}
      />
    </section>
  );
}

function SettingRow({
  label,
  value,
  action,
  onClick,
}: {
  label: string;
  value: ReactNode;
  action: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-0.5 border-t border-edge px-5 py-3 text-sm sm:grid-cols-[12rem_1fr_auto]">
      <span className="text-fg-muted">{label}</span>
      <span className="col-start-1 row-start-2 text-fg tabular-nums sm:col-start-2 sm:row-start-1">{value}</span>
      <button
        type="button"
        onClick={onClick}
        aria-label={`${action} ${label.toLowerCase()}`}
        className="row-span-2 text-primary hover:underline sm:row-span-1"
      >
        {action}
      </button>
    </div>
  );
}
