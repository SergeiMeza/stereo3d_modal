"use client";

/**
 * The account's Business or Studio plan on Billing (pricing 2026-11):
 * what's left of this month's usage, when it renews, Cancel / Resume.
 */

import Link from "next/link";
import type { JSX } from "react";

import { isTeamPlan } from "@/lib/api/types";
import { PlanEmailPrompt } from "./PlanEmailPrompt";
import { planPrice } from "@/components/pricing/planCopy";

import { PlanChangeMenu, ScheduledChange } from "./PlanChange";
import { formatCents } from "@/components/steps/money";
import { useBilling } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

/** "10 Jan 2027" in English (en-GB order); the language's own order else. */
export function longDate(iso: string, t: Tr = EN): string {
  return new Date(iso).toLocaleDateString(t.locale === "en" ? "en-GB" : t.intl, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function PlanCard(): JSX.Element | null {
  const t = useT();
  const billing = useBilling();
  const plan = billing.status?.plan;
  if (!plan?.active) return null;
  const credit = plan.credit_cents ?? 0;
  const left = plan.credit_left_cents ?? credit;
  const used =
    credit > 0 ? Math.min(1, Math.max(0, (credit - left) / credit)) : 0;

  return (
    <section
      data-testid="plan-card"
      aria-labelledby="plan-title"
      className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="plan-title" className="text-sm font-semibold text-fg">
          {t("billing.plan.title", { name: plan.name ?? plan.plan })}
        </h2>
        {planPrice(plan).cents > 0 ? (
          <span
            data-testid="plan-price"
            className="text-xs text-fg-muted tabular-nums"
          >
            {formatCents(planPrice(plan).cents, t)} {planPrice(plan).per}
          </span>
        ) : null}
        <span className="ms-auto">
          {/* owner 2026-11-04: step-downs and cancelling wait for the period's end */}
          <PlanChangeMenu plan={plan} />
        </span>
      </div>
      <ScheduledChange plan={plan} />
      {/* gateway 00152: a Business or Studio plan needs a real main email */}
      {isTeamPlan(plan) ? <PlanEmailPrompt load /> : null}
      {credit > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p data-testid="plan-credit" className="text-sm text-fg tabular-nums">
            {t("billing.plan.creditLeft", { left: formatCents(left, t), credit: formatCents(credit, t) })}
          </p>
          {plan.credit_resets_at ? (
            // Studio yearly: the usage resets every month of the year
            <p
              data-testid="plan-credit-resets"
              className="text-xs text-fg-muted"
            >
              {t("billing.plan.usageResets", { date: longDate(plan.credit_resets_at, t) })}
            </p>
          ) : null}
          <span
            aria-hidden
            className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
          >
            <span
              className="block h-full rounded-full bg-primary"
              style={{ width: `${used * 100}%` }}
            />
          </span>
        </div>
      ) : null}
      {plan.current_period_end &&
      !plan.cancel_at_period_end &&
      !plan.scheduled_change ? (
        <p className="text-xs text-fg-muted">
          {t(planPrice(plan).yearly ? "billing.plan.billedYearlyRenewsOn" : "billing.plan.renewsOn", {
            date: longDate(plan.current_period_end, t),
          })}{" "}
          <Link href="/plans" className="text-primary hover:underline">
            {t("billing.plan.plansLink")}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
