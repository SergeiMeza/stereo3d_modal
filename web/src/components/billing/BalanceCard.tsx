"use client";

/**
 * P10 Balance (spec v7 §N, mock p10/p10g): the prepaid balance at the top
 * of Billing — the amount, what's reserved, when it expires, Add funds
 * (P17), and the Auto-reload (P18), Monthly spend limit and Balance alert
 * (P19) rows.
 */

import { PlusIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { useBalanceDialogs } from "@/components/pay/BalanceDialogs";
import { liveProCredit } from "@/components/pro/ProCredit";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { isTeamPlan, prepaidOf } from "@/lib/api/types";
import type { AccountPlan, BalanceCredit, BalanceSummary, ProCreditStatus } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { billingReadVersionAtom, useBilling } from "@/lib/billing";
import type { LiveBalance } from "@/lib/live/events";
import { liveBalanceAtom } from "@/lib/live/liveStore";
import { useLiveFeed } from "@/lib/live/useLive";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import { useAppAtomValue } from "@/lib/state/stores";

/** The read balance with the live feed's numbers on top when they're
 * newer (the feed sends the spendable amount and what runs hold). */
export function liveBalance(read: BalanceSummary, live: LiveBalance | null, readVersion: number): BalanceSummary {
  if (live === null || live.version <= readVersion) return read;
  return {
    ...read,
    ...(typeof live.balance_cents === "number" ? { available_cents: live.balance_cents } : {}),
    ...(typeof live.held_cents === "number" ? { held_cents: live.held_cents } : {}),
  };
}

/** English reads day-first here ("7 Dec 2026"); another language its own way. */
function dateTag(t: Tr): string {
  return t.locale === "en" ? "en-GB" : t.intl;
}

function longDate(iso: string, t: Tr): string {
  return new Date(iso).toLocaleDateString(dateTag(t), { day: "numeric", month: "short", year: "numeric" });
}

/** "5 Dec" */
function dayMonth(iso: string, t: Tr): string {
  return new Date(iso).toLocaleDateString(dateTag(t), { day: "numeric", month: "short" });
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


/** A credit's words: "$100.00 usage credit (use by 7 Dec)". */
function creditWords(kind: BalanceCredit["kind"], t: Tr): string {
  if (kind === "pro") return t("billing.balance.creditWords.pro", { pro: "Pro" });
  if (kind === "plan") return t("billing.balance.creditWords.plan");
  return t("billing.balance.creditWords.grant");
}

/** The credits in the balance, left and still usable: the gateway's
 * balance.credits (spent or expired ones left out), else, on older
 * gateways, the plan's usage and Pro's credit from their own fields. */
export function balanceCredits(
  b: BalanceSummary,
  plan: AccountPlan | null | undefined,
  pro: ProCreditStatus | null | undefined,
  now = Date.now(),
): BalanceCredit[] {
  if (b.credits) {
    return b.credits.filter((c) => c.cents > 0 && (!c.expires_at || new Date(c.expires_at).getTime() > now));
  }
  return [
    ...(isTeamPlan(plan)
      ? [{ kind: "plan" as const, cents: plan.credit_left_cents ?? plan.credit_cents ?? 0, expires_at: plan.credit_resets_at ?? plan.current_period_end ?? null }]
      : []),
    ...(pro?.granted ? [{ kind: "pro" as const, cents: pro.left_cents, expires_at: pro.expires_at }] : []),
  ].filter((c) => c.cents > 0);
}

/** "includes $100.00 usage credit (use by 7 Dec) and $20.00 Pro credit
 * (use by 7 Dec)"; null without credit. */
export function creditsLine(credits: BalanceCredit[], t: Tr = EN): string | null {
  if (credits.length === 0) return null;
  const parts = credits.map((c) => {
    const values = { amount: formatCents(c.cents, t), words: creditWords(c.kind, t) };
    return c.expires_at
      ? t("billing.balance.creditItemUseBy", { ...values, date: dayMonth(c.expires_at, t) })
      : t("billing.balance.creditItem", values);
  });
  const joined =
    parts.length === 1
      ? parts[0]
      : t("billing.balance.creditsAnd", { rest: parts.slice(0, -1).join(", "), last: parts.at(-1) });
  return t("billing.balance.includes", { credits: joined });
}

/** The paused reasons with their own line (others read as declined). */
function pausedLine(reason: string, t: Tr): string {
  return reason === "limit" ? t("billing.balance.paused.limit") : t("billing.balance.paused.declined");
}

export function BalanceCard(): JSX.Element | null {
  const { status } = useBilling();
  const t = useT();
  const gateway = useGateway();
  const billing = useBilling();
  const { openAddFunds, openAutoReload, openSpending } = useBalanceDialogs();
  // owner 2026-11-07: the balance from the live feed (billing.updated and
  // the snapshot) when it's newer than the last billing read
  useLiveFeed();
  const live = useAppAtomValue(liveBalanceAtom);
  const readVersion = useAppAtomValue(billingReadVersionAtom);
  if (status === null) {
    return <div data-testid="balance-loading" className="h-44 animate-pulse rounded-xl bg-surface-1" />;
  }
  const read = prepaidOf(status);
  if (!read) return null; // a gateway without the balance yet
  const b = liveBalance(read, live, readVersion);
  const ar = b.auto_reload;
  // owner 2026-11-07 (D): paused while a reload is being retried
  const retrying = ar.retry?.state === "pending";
  const paused = ar.enabled && retrying ? t("billing.balance.paused.retrying") : ar.enabled && ar.paused_reason ? pausedLine(ar.paused_reason, t) : null;
  const limit = b.spend_limit_cents ?? null;
  const used = limit ? Math.min(1, b.month_spent_cents / limit) : 0;
  const plan = isTeamPlan(status.plan) ? status.plan : null;
  const proCredit = liveProCredit(status.pro_credit);
  const prepaid = prepaidCents(b, plan, proCredit?.left_cents ?? 0);
  // owner 2026-11-07: the headline is everything spendable, credit
  // included; the credit is spelled out under it, the cash by Add funds
  const credits = balanceCredits(b, plan, proCredit);
  const creditLine = creditsLine(credits, t);
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
            {t("billing.balance.title")}
          </h2>
          <p data-testid="balance-amount" className="text-4xl font-semibold tracking-tight text-fg tabular-nums">
            {formatCents(Math.max(b.available_cents, 0), t)}
          </p>
          <p data-testid="balance-credits" className="text-xs text-fg-muted tabular-nums">
            {creditLine ? t("billing.balance.availableWithCredits", { credits: creditLine }) : t("billing.balance.available")}
          </p>
          {b.held_cents > 0 ? (
            <p className="text-xs text-fg-muted tabular-nums">
              {t("billing.balance.reserved", { amount: formatCents(b.held_cents, t), count: b.held_runs ?? 1 })}
            </p>
          ) : null}
          {frozen > 0 ? (
            <p data-testid="balance-frozen" className="text-xs text-amber-200 tabular-nums">
              {t("billing.balance.frozen", { amount: formatCents(frozen, t) })}
            </p>
          ) : null}
          {b.expired && b.expires_at ? (
            <p className="text-xs text-fg-muted">{t("billing.balance.expired", { date: longDate(b.expires_at, t) })}</p>
          ) : b.never_topped_up && prepaid === 0 && credits.length === 0 ? (
            <p className="text-xs text-fg-muted">{t("billing.balance.addFundsHint")}</p>
          ) : expires ? (
            <p data-testid="balance-expires" className="text-xs text-fg-muted">
              {t("billing.balance.expires", { date: longDate(expires, t) })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button size="lg" data-testid="balance-add-funds" onClick={openAddFunds}>
            <PlusIcon className="size-4" aria-hidden />
            {t("billing.balance.addFunds")}
          </Button>
          <span data-testid="balance-prepaid" className="text-xs text-fg-muted tabular-nums">
            {t("billing.balance.prepaid", { amount: formatCents(prepaid, t) })}
          </span>
        </div>
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
              {t("billing.balance.turnBackOn")}
            </button>
          ) : null}
        </div>
      ) : null}
      <SettingRow
        label={t("billing.balance.autoReload")}
        value={
          ar.enabled
            ? t("billing.balance.autoReloadValue", { below: formatCents(ar.below_cents, t), add: formatCents(ar.add_cents, t) })
            : t("billing.balance.off")
        }
        action={ar.enabled ? t("billing.balance.edit") : t("billing.balance.setUp")}
        onClick={openAutoReload}
      />
      <SettingRow
        label={t("billing.balance.spendLimit")}
        value={
          limit ? (
            <span className="flex items-center gap-3">
              {t("billing.balance.spendLimitValue", { limit: formatCentsShort(limit, t), used: formatCents(b.month_spent_cents, t) })}
              <span aria-hidden className="hidden h-1 w-28 overflow-hidden rounded-full bg-surface-2 sm:block">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${used * 100}%` }} />
              </span>
            </span>
          ) : (
            t("billing.balance.none")
          )
        }
        action={limit ? t("billing.balance.edit") : t("billing.balance.set")}
        onClick={openSpending}
      />
      <SettingRow
        label={t("billing.balance.balanceAlert")}
        value={t("billing.balance.balanceAlertValue", { amount: formatCents(b.low_balance_cents, t) })}
        action={t("billing.balance.edit")}
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
  const t = useT();
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-0.5 border-t border-edge px-5 py-3 text-sm sm:grid-cols-[12rem_1fr_auto]">
      <span className="text-fg-muted">{label}</span>
      <span className="col-start-1 row-start-2 text-fg tabular-nums sm:col-start-2 sm:row-start-1">{value}</span>
      <button
        type="button"
        onClick={onClick}
        aria-label={t("billing.balance.rowAction", { action, label: label.toLocaleLowerCase(t.intl) })}
        className="row-span-2 text-primary hover:underline sm:row-span-1"
      >
        {action}
      </button>
    </div>
  );
}
