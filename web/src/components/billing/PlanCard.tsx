"use client";

/**
 * The account's Business or Studio plan on Billing (pricing 2026-11):
 * what's left of this month's usage, when it renews, Cancel / Resume.
 */

import Link from "next/link";
import { useState } from "react";
import type { JSX } from "react";

import { isTeamPlan } from "@/lib/api/types";
import { PlanEmailPrompt } from "./PlanEmailPrompt";
import { planPrice } from "@/components/pricing/planCopy";

import { PlanChangeMenu, ScheduledChange } from "./PlanChange";
import { formatCents } from "@/components/steps/money";
import { GatewayError } from "@/lib/api/client";
import { useBilling } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import { SITE_NAME } from "@/lib/site";
import { useAccountSettings } from "@/lib/useAccountSettings";

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
        <span className="ml-auto">
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
      <IntroSwitch />
    </section>
  );
}

/**
 * BL-25: Business and Studio can turn the Spatial Video Studio intro off. Shown only
 * when GET /v1/account/settings says it's editable; the switch moves at
 * once and goes back if the save fails. 409 plan_required hides it and
 * reads the settings again.
 */
export function IntroSwitch(): JSX.Element | null {
  const t = useT();
  const billing = useBilling();
  // ADR 0138: the account's settings atom (useAccountSettings), shared
  // with onboarding and Make 3D
  const { settings, replace, save, refresh } = useAccountSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  if (!settings?.lifelike_intro_editable) return null;
  const on = settings.lifelike_intro;

  async function toggle(): Promise<void> {
    if (!settings || saving) return;
    const before = settings;
    replace({ ...before, lifelike_intro: !on });
    setSaving(true);
    setError(false);
    try {
      await save({ lifelike_intro: !on });
    } catch (e) {
      if (e instanceof GatewayError && e.code === "plan_required") {
        // the plan ended meanwhile: no switch, and the page catches up
        replace({ ...before, lifelike_intro_editable: false });
        refresh();
        void billing.refresh();
      } else {
        replace(before);
        setError(true);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      data-testid="intro-switch"
      className="flex flex-col gap-1 border-t border-edge pt-3"
    >
      <label className="flex items-center justify-between gap-3 text-sm text-fg">
        {t("billing.plan.introLabel", { app: SITE_NAME })}
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t("billing.plan.introLabel", { app: SITE_NAME })}
          disabled={saving}
          onClick={() => void toggle()}
          className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-70 ${
            on ? "bg-primary" : "bg-surface-2 ring-1 ring-edge"
          }`}
        >
          <span
            className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`}
          />
        </button>
      </label>
      <p className="text-xs text-fg-muted">
        {t("billing.plan.introHint", { app: SITE_NAME })}
      </p>
      {error ? (
        <p className="text-xs text-red-400">
          {t("billing.plan.introSaveFailed")}
        </p>
      ) : null}
    </div>
  );
}
