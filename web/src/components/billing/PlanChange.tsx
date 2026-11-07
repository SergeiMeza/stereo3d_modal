"use client";

/**
 * Stepping down (owner 2026-11-04): a lower plan starts at the end of the
 * paid period, nothing is charged today.
 *
 * - PlanChangeMenu (Billing plan card): "Change plan" lists the lower
 *   options — Studio → Business or Pro, Business → Pro — and "Pay per
 *   video", which cancels the plan at the end of the period. Each opens a
 *   confirmation built from POST /v1/plans/preview-change: "Your Studio
 *   stays on until Jan 10, 2027. Business starts then at $299 a month.
 *   Nothing is charged today." Business → Studio (owner 2026-11-04) is a
 *   step-up at once: "Today: $X. Studio $A − $B for your unused Business."
 * - ScheduledChange (Billing and Account): the waiting change, with "Keep
 *   Studio" (DELETE /v1/plans/scheduled-change) until the date.
 */

import { StepUpPayLink } from "./StepUpPayLink";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { planPrice } from "@/components/pricing/planCopy";
import { formatCents } from "@/components/steps/money";

import {
  closePlanChangeAtom,
  confirmPlanChangeAtom,
  planChangeAtom,
  previewPlanChangeAtom,
} from "./planChangeAtoms";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GatewayError } from "@/lib/api/client";
import type { AccountPlan, PublicPricing } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { usePricing } from "@/lib/api/usePricing";
import { awaitPlanCredit, useBilling } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import { planName as proPeriodName } from "@/lib/pro/plans";
import { notifyProChanged, useProPlans } from "@/lib/pro/usePro";

import {
  changeDate,
  isStepDown,
  planEnds,
  nextPlanLine,
  stepDownLine,
  upgradeLine,
} from "./planChangeCopy";
import { StepUpExtras } from "./StepUpDetails";

export const PAY_PER_VIDEO = "pay_per_video";

/** Highest to lowest (owner 2026-11-04: a lower plan is a step-down). */
const PLAN_RANK: Record<string, number> = {
  studio: 40,
  business: 30,
  pro_yearly: 23,
  pro_monthly: 22,
  pro_weekly: 21,
  pay_per_video: 0,
};

interface Option {
  id: string;
  /** "Business", "Pro Monthly", or null for pay per video */
  name: string | null;
  per?: string;
  /** what it costs each period, when known (team plans) */
  cents?: number;
  /** an id this build doesn't know: the line names no plan */
  unknown?: boolean;
}

/** "a month": how a Pro period bills. */
function proPer(kind: "weekly" | "monthly" | "yearly", t: Tr): string {
  if (kind === "weekly") return t("billing.planChange.per.weekly");
  if (kind === "yearly") return t("billing.planChange.per.yearly");
  return t("billing.planChange.per.monthly");
}

/** What a plan id is called and how it bills. */
export function optionFor(
  id: string,
  pricing: PublicPricing | null,
  proNames: Map<string, Option>,
): Option {
  // gateway 00138: "pay_per_video" (older answers said "none")
  if (id === PAY_PER_VIDEO || id === "none" || id === "") return { id: PAY_PER_VIDEO, name: null };
  if (id === "business" || id === "studio") {
    const def = pricing?.plans?.[id];
    return {
      id,
      name: def?.name ?? (id === "studio" ? "Studio" : "Business"),
      per: def ? planPrice(def).per : undefined,
      cents: def ? planPrice(def).cents : undefined,
    };
  }
  const pro = proNames.get(id);
  if (pro) return pro;
  if (id.startsWith("pro_") || id === "pro") return { id, name: "Pro" };
  // never guess: an unknown id names no plan
  return { id, name: null, unknown: true };
}

/** An option as nextPlanLine takes it (null: pay per video). */
export function nextOption(o: Option): { name: string | null; per?: string; cents?: number; unknown?: boolean } | null {
  if (o.unknown) return { name: null, unknown: true };
  return o.name === null ? null : { name: o.name, per: o.per, cents: o.cents };
}

function planLabel(plan: AccountPlan): string {
  return plan.name ?? (plan.plan === "studio" ? "Studio" : "Business");
}

const SCOPE = "plan-menu";

/** "Your Studio ends on Jan 10, 2027 instead of changing to Business." */
export function cancelOverStepDownLine(current: string, endIso: string | null | undefined, next: string, t: Tr = EN): string {
  const end = endIso ? changeDate(endIso, t) : t("billing.planChange.endOfPeriod");
  return t("billing.planChange.cancelOverStepDown", { current, end, next });
}

/** ?cancel=1 in the address (Account's "Cancel plan"). */
function cancelAsked(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("cancel") === "1";
}

/** Drops ?cancel=1 so a reload doesn't reopen it; true when it was there. */
function dropCancelParam(): boolean {
  if (!cancelAsked()) return false;
  const url = new URL(window.location.href);
  url.searchParams.delete("cancel");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  return true;
}

export function PlanChangeMenu({
  plan,
}: {
  plan: AccountPlan;
}): JSX.Element | null {
  const t = useT();
  const gateway = useGateway();
  const billing = useBilling();
  const pricing = usePricing();
  const proPlans = useProPlans();
  const [target, setTarget] = useState<Option | null>(() =>
    !planEnds(plan) && cancelAsked()
      ? { id: PAY_PER_VIDEO, name: null }
      : null,
  );
  // ADR 0138: the preview and the confirm live in the plan change atom
  const change = useAtomValue(planChangeAtom(SCOPE));
  const previewChange = useSetAtom(previewPlanChangeAtom);
  const confirmChange = useSetAtom(confirmPlanChangeAtom);
  const closeChange = useSetAtom(closePlanChangeAtom);
  const preview = change.to === target?.id ? change.preview : null;
  const error =
    change.error ?? (change.previewFailed ? t("billing.planChange.errors.previewFailed") : null);
  const notice = change.repriced ? t("billing.planChange.repriced") : null;
  const busy = change.busy;

  // our own Stripe Pro only: those are the ones a plan can step down to
  const pro =
    proPlans.state === "ready"
      ? proPlans.plans.map((p) => ({
          id: p.id,
          name: t("billing.planChange.proName", { pro: "Pro", period: proPeriodName(p) }),
          per: proPer(p.kind, t),
        }))
      : [];
  const proNames = new Map(pro.map((o) => [o.id, o]));
  // lower plans, and (owner 2026-11-04) Business → Studio as a step-up
  const rank = PLAN_RANK[plan.plan_id ?? plan.plan] ?? 0;
  const higher: Option[] =
    plan.plan === "business" ? [optionFor("studio", pricing, proNames)] : [];
  const lower: Option[] = [
    ...(plan.plan === "studio"
      ? [optionFor("business", pricing, proNames)]
      : []),
    ...pro.filter((o) => (PLAN_RANK[o.id] ?? 0) < rank),
    { id: PAY_PER_VIDEO, name: null },
  ];
  // owner 2026-11-06: Account's "Cancel plan" (a renewing plan blocks
  // deleting the account) lands here with ?cancel=1: the cancel
  // confirmation opens once, and the parameter is dropped
  const canChange = !plan.scheduled_change && !plan.cancel_at_period_end;
  // a waiting step-down can still be cancelled: cancelling replaces it
  // (the coordinator, 2026-11-06)
  const canCancel = !planEnds(plan);
  useEffect(() => {
    if (!canCancel || !dropCancelParam()) return;
    void previewChange({ scope: SCOPE, client: gateway, to: PAY_PER_VIDEO });
  }, [canCancel, gateway, previewChange]);
  if (!canCancel) return null;
  const current = planLabel(plan);
  const waiting = plan.scheduled_change
    ? nextOption(optionFor(plan.scheduled_change.to, pricing, proNames))
    : null;

  function open(o: Option): void {
    setTarget(o);
    void previewChange({ scope: SCOPE, client: gateway, to: o.id });
  }

  async function confirm(): Promise<void> {
    if (!target || !preview) return;
    if ((await confirmChange({ scope: SCOPE, client: gateway, t })) === "done") {
      await billing.refresh();
      // a step-up's usage lands a moment later: keep reading until it shows
      void awaitPlanCredit();
      setTarget(null);
      closeChange(SCOPE);
    }
  }

  return (
    <>
      {canChange ? (
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" data-testid="plan-change">
            {t("billing.planChange.changePlan")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {higher.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => open(o)}>
              {t("billing.planChange.moveUp", { name: o.name ?? "" })}
            </DropdownMenuItem>
          ))}
          {lower.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => open(o)}>
              {o.name ?? t("billing.planChange.payPerVideoCancel")}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      ) : null}
      <AlertDialog
        open={target !== null}
        onOpenChange={(o) => {
          if (o) return;
          setTarget(null);
          closeChange(SCOPE);
        }}
      >
        <AlertDialogContent data-testid="plan-change-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target?.name
                ? t("billing.planChange.dialogTitleChange", { name: target.name })
                : t("billing.planChange.dialogTitleCancel", { current })}
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="plan-change-line">
              {error ??
                (preview && target
                  ? target.id === PAY_PER_VIDEO && waiting?.name
                    ? // cancelling over a waiting step-down replaces it
                      `${cancelOverStepDownLine(current, preview.effective_at ?? plan.current_period_end, waiting.name, t)} ${t("billing.planChange.nothingToday")}`
                    : isStepDown(preview)
                    ? // gateway 00138: the preview's `to`, as the card reads scheduled_change.to
                      `${stepDownLine(current, nextOption(optionFor(preview.to ?? target.id, pricing, proNames)), preview, t)} ${t("billing.planChange.nothingToday")}`
                    : upgradeLine(
                        preview,
                        {
                          from: current,
                          to: target.name ?? "",
                        },
                        t,
                      )
                  : t("billing.planChange.working"))}
            </AlertDialogDescription>
            {error ? <StepUpPayLink payUrl={change.payUrl} amountCents={preview?.today_cents} /> : null}
            {preview && target?.name && !error && !isStepDown(preview) ? (
              <StepUpExtras
                preview={preview}
                from={current}
                to={target.name}
                handoverCreditCents={
                  pricing?.plans?.[target.id as "studio"]?.credit_cents ?? null
                }
              />
            ) : null}
            {notice ? (
              <p role="status" className="text-xs text-amber-300">
                {notice}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("billing.planChange.keep", { current })}</AlertDialogCancel>
            <AlertDialogAction
              disabled={preview === null || busy}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              {preview && target?.name && !isStepDown(preview)
                ? t("billing.planChange.payAndChange", { amount: formatCents(preview.today_cents, t) })
                : target?.name
                  ? t("billing.planChange.changeTo", { name: target.name })
                  : t("billing.planChange.cancelPlan")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** "Business starts on Jan 10, 2027. Your Studio stays on until then."
 * with Keep Studio; or, when cancelled, "Your Studio ends on …". */
export function ScheduledChange({
  plan,
}: {
  plan: AccountPlan;
}): JSX.Element | null {
  const t = useT();
  const gateway = useGateway();
  const billing = useBilling();
  const pricing = usePricing();
  const proPlans = useProPlans();
  const [busy, setBusy] = useState(false);
  /** false, or the gateway's words (409 not_renewable, gateway 00155) */
  const [error, setError] = useState<false | string>(false);
  const sc = plan.scheduled_change;
  const ending = plan.cancel_at_period_end && plan.current_period_end;
  if (!sc && !ending) return null;
  const current = planLabel(plan);
  const proNames = new Map(
    proPlans.state === "ready"
      ? proPlans.plans.map(
          (p) => [p.id, { id: p.id, name: t("billing.planChange.proName", { pro: "Pro", period: proPeriodName(p) }) }] as const,
        )
      : [],
  );
  const to = sc ? optionFor(sc.to, pricing, proNames) : null;

  async function keep(): Promise<void> {
    setBusy(true);
    setError(false);
    try {
      if (sc) await gateway.cancelScheduledChange();
      else await gateway.cancelPlan(true);
      await billing.refresh();
      notifyProChanged();
    } catch (e) {
      setError(e instanceof GatewayError && e.code === "not_renewable" && e.message ? e.message : t("billing.planChange.errors.keepFailed"));
    } finally {
      setBusy(false);
    }
  }

  // one wording with the change dialog (nextPlanLine), from
  // scheduled_change.to (gateway 00138); a plain cancel is pay per video
  const line = nextPlanLine(current, sc?.effective_at ?? plan.current_period_end, to ? nextOption(to) : null, t);

  return (
    <div
      data-testid="scheduled-change"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs"
    >
      <p className="min-w-48 flex-1 text-fg">{line}</p>
      {/* a restored plan runs to its end: nothing to keep (gateway 00152) */}
      {ending && !sc && (plan.restored_from || plan.renewable === false) ? null : (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void keep()}
        >
          {t("billing.planChange.keep", { current })}
        </Button>
      )}
      {error ? <p className="w-full text-red-400">{error}</p> : null}
    </div>
  );
}

/** Account page: the waiting change of the account's plan, if any. */
export function AccountScheduledChange(): JSX.Element | null {
  const plan = useBilling().status?.plan;
  if (!plan?.active) return null;
  return <ScheduledChange plan={plan} />;
}
