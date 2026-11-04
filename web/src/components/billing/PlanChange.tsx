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
 *   Nothing is charged today." Business → Studio stays hidden (on hold).
 * - ScheduledChange (Billing and Account): the waiting change, with "Keep
 *   Studio" (DELETE /v1/plans/scheduled-change) until the date.
 */

import { useState } from "react";
import type { JSX } from "react";

import { planPrice } from "@/components/pricing/planCopy";
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
import type { PlanChangePreview } from "@/lib/api/client";
import type { AccountPlan, PublicPricing } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { usePricing } from "@/lib/api/usePricing";
import { useBilling } from "@/lib/billing";
import { planName as proPeriodName } from "@/lib/pro/plans";
import { notifyProChanged, useProPlans } from "@/lib/pro/usePro";

import {
  changeDate,
  confirmPlanChange,
  NOTHING_TODAY,
  REPRICED,
  stepDownLine,
} from "./planChangeCopy";

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
}

const PRO_PER = {
  weekly: "a week",
  monthly: "a month",
  yearly: "a year",
} as const;

/** What a plan id is called and how it bills. */
export function optionFor(
  id: string,
  pricing: PublicPricing | null,
  proNames: Map<string, Option>,
): Option {
  if (id === PAY_PER_VIDEO) return { id, name: null };
  if (id === "business" || id === "studio") {
    const def = pricing?.plans?.[id];
    return {
      id,
      name: def?.name ?? (id === "studio" ? "Studio" : "Business"),
      per: def ? planPrice(def).per : undefined,
    };
  }
  return proNames.get(id) ?? { id, name: "Pro" };
}

function planLabel(plan: AccountPlan): string {
  return plan.name ?? (plan.plan === "studio" ? "Studio" : "Business");
}

export function PlanChangeMenu({
  plan,
}: {
  plan: AccountPlan;
}): JSX.Element | null {
  const gateway = useGateway();
  const billing = useBilling();
  const pricing = usePricing();
  const proPlans = useProPlans();
  const [target, setTarget] = useState<Option | null>(null);
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // our own Stripe Pro only: those are the ones a plan can step down to
  const pro =
    proPlans.state === "ready"
      ? proPlans.plans.map((p) => ({
          id: p.id,
          name: `Pro ${proPeriodName(p)}`,
          per: PRO_PER[p.kind],
        }))
      : [];
  const proNames = new Map(pro.map((o) => [o.id, o]));
  // only lower plans (Business → Studio is on hold; upgrades go through setup)
  const rank = PLAN_RANK[plan.plan_id ?? plan.plan] ?? 0;
  const lower: Option[] = [
    ...(plan.plan === "studio"
      ? [optionFor("business", pricing, proNames)]
      : []),
    ...pro.filter((o) => (PLAN_RANK[o.id] ?? 0) < rank),
    { id: PAY_PER_VIDEO, name: null },
  ];
  if (plan.scheduled_change || plan.cancel_at_period_end) return null;
  const current = planLabel(plan);

  function open(o: Option): void {
    setTarget(o);
    setError(null);
    setNotice(null);
    setPreview(null);
    gateway
      .previewPlanChange(o.id)
      .then(setPreview, () =>
        setError("Couldn't work out the change. Nothing was charged."),
      );
  }

  async function confirm(): Promise<void> {
    if (!target || !preview) return;
    setBusy(true);
    setError(null);
    const r = await confirmPlanChange(gateway, preview);
    setBusy(false);
    if (r.kind === "done") {
      await billing.refresh();
      setTarget(null);
    } else if (r.kind === "repriced") {
      setPreview(r.preview);
      setNotice(REPRICED);
    } else setError(r.message);
  }

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" data-testid="plan-change">
            Change plan
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {lower.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => open(o)}>
              {o.name ?? "Pay per video (cancel plan)"}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
      >
        <AlertDialogContent data-testid="plan-change-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target?.name
                ? `Change to ${target.name}?`
                : `Cancel ${current}?`}
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="plan-change-line">
              {error ??
                (preview && target
                  ? `${stepDownLine(current, target.name ? { name: target.name, per: target.per } : null, preview)} ${NOTHING_TODAY}`
                  : "Working out the change…")}
            </AlertDialogDescription>
            {notice ? (
              <p role="status" className="text-xs text-amber-300">
                {notice}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep {current}</AlertDialogCancel>
            <AlertDialogAction
              disabled={preview === null || busy}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              {target?.name ? `Change to ${target.name}` : "Cancel plan"}
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
  const gateway = useGateway();
  const billing = useBilling();
  const pricing = usePricing();
  const proPlans = useProPlans();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const sc = plan.scheduled_change;
  const ending = plan.cancel_at_period_end && plan.current_period_end;
  if (!sc && !ending) return null;
  const current = planLabel(plan);
  const proNames = new Map(
    proPlans.state === "ready"
      ? proPlans.plans.map(
          (p) => [p.id, { id: p.id, name: `Pro ${proPeriodName(p)}` }] as const,
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
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const line =
    sc && to?.name
      ? `${to.name} starts on ${changeDate(sc.effective_at)}. Your ${current} stays on until then.`
      : `Your ${current} ends on ${changeDate(sc?.effective_at ?? plan.current_period_end!)}. After that you pay per video.`;

  return (
    <div
      data-testid="scheduled-change"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs"
    >
      <p className="min-w-48 flex-1 text-fg">{line}</p>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void keep()}
      >
        Keep {current}
      </Button>
      {error ? (
        <p className="w-full text-red-400">
          Couldn&apos;t keep your plan. Try again.
        </p>
      ) : null}
    </div>
  );
}

/** Account page: the waiting change of the account's plan, if any. */
export function AccountScheduledChange(): JSX.Element | null {
  const plan = useBilling().status?.plan;
  if (!plan?.active) return null;
  return <ScheduledChange plan={plan} />;
}
