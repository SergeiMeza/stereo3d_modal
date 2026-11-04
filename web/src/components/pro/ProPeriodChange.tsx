"use client";

/**
 * A web Pro (our own Stripe subscription) changes its period here (owner
 * 2026-11-04): POST /v1/plans/preview-change {to} first — "Today: $X (new
 * plan $A − $B for your unused Pro days). Renews on <date>", or for a
 * shorter period the step-down at the end of the paid one — then POST
 * /v1/plans/change {to, confirm: true}. Nothing is charged before
 * confirm.
 */

import { useAtomValue, useSetAtom } from "jotai";
import { useState } from "react";
import type { JSX } from "react";

import {
  isStepDown,
  NOTHING_TODAY,
  REPRICED,
  stepDownLine,
  upgradeLine,
} from "@/components/billing/planChangeCopy";
import { formatCents } from "@/components/steps/money";
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
import type { PlanChangePreview } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";
import {
  closePlanChangeAtom,
  confirmPlanChangeAtom,
  planChangeAtom,
  previewPlanChangeAtom,
} from "@/components/billing/planChangeAtoms";
import { StepUpExtras } from "@/components/billing/StepUpDetails";
import { planName } from "@/lib/pro/plans";
import type { ProPlan } from "@/lib/pro/plans";
import {
  isWebPro,
  notifyProChanged,
  useProPlans,
  useProStatus,
} from "@/lib/pro/usePro";

const PER = { weekly: "a week", monthly: "a month", yearly: "a year" } as const;

/** The dialog's line: today's charge for a longer period, or for a
 * shorter one "Your Pro Yearly stays on until … Pro Monthly starts then
 * at $8.99 a month." */
export function previewLine(
  p: PlanChangePreview,
  current: ProPlan | undefined,
  target: ProPlan,
): string {
  if (isStepDown(p)) {
    return `${stepDownLine(current ? `Pro ${planName(current)}` : "Pro", { name: `Pro ${planName(target)}`, per: PER[target.kind] }, p)} ${NOTHING_TODAY}`;
  }
  return upgradeLine(p, {
    from: current ? `Pro ${planName(current)}` : "Pro",
    to: `Pro ${planName(target)}`,
  });
}

const SCOPE = "pro-period";

export function ProPeriodChange(): JSX.Element | null {
  const gateway = useGateway();
  const status = useProStatus();
  const plans = useProPlans();
  const [target, setTarget] = useState<ProPlan | null>(null);
  const billing = useBilling();
  // ADR 0138: the preview and the confirm live in the plan change atom
  const change = useAtomValue(planChangeAtom(SCOPE));
  const previewChange = useSetAtom(previewPlanChangeAtom);
  const confirmChange = useSetAtom(confirmPlanChangeAtom);
  const closeChange = useSetAtom(closePlanChangeAtom);
  const preview = change.to === target?.id ? change.preview : null;
  const error =
    change.error ?? (change.previewFailed ? "Couldn't work out the price. Nothing was charged." : null);
  const notice = change.repriced ? REPRICED : null;
  const busy = change.busy;
  if (!isWebPro(status) || plans.state !== "ready") return null;
  // a step-down already waits for the period's end: Keep is on the page
  if (status?.scheduled_change) return null;
  const current = status?.plan_id ?? status?.via;
  const others = plans.plans.filter((p) => p.id !== current);
  const currentPlan = plans.plans.find((p) => p.id === current);
  if (others.length === 0) return null;

  function open(p: ProPlan): void {
    setTarget(p);
    void previewChange({ scope: SCOPE, client: gateway, to: p.id });
  }

  async function confirm(): Promise<void> {
    if (!target || !preview) return;
    if ((await confirmChange({ scope: SCOPE, client: gateway })) === "done") {
      void gateway.refreshPro().catch(() => {});
      notifyProChanged();
      void billing.refresh();
      setTarget(null);
      closeChange(SCOPE);
    }
  }

  return (
    <div data-testid="pro-period-change" className="flex flex-wrap gap-2">
      {others.map((p) => (
        <Button key={p.id} variant="outline" size="sm" onClick={() => open(p)}>
          Switch to {planName(p)}
        </Button>
      ))}
      <AlertDialog
        open={target !== null}
        onOpenChange={(o) => {
          if (o) return;
          setTarget(null);
          closeChange(SCOPE);
        }}
      >
        <AlertDialogContent data-testid="pro-change-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch to Pro {target ? planName(target) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="pro-change-preview">
              {error ??
                (preview && target
                  ? previewLine(preview, currentPlan, target)
                  : "Working out today's price…")}
            </AlertDialogDescription>
            {preview && target && !error && !isStepDown(preview) ? (
              <StepUpExtras
                preview={preview}
                from={currentPlan ? `Pro ${planName(currentPlan)}` : "Pro"}
                to={`Pro ${planName(target)}`}
              />
            ) : null}
            {notice ? (
              <p role="status" className="text-xs text-amber-300">
                {notice}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my plan</AlertDialogCancel>
            <AlertDialogAction
              disabled={preview === null || busy}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              {preview && !isStepDown(preview)
                ? `Confirm and pay ${formatCents(preview.today_cents)}`
                : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
