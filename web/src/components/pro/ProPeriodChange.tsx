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

import { isStepDown, stepDownLine, upgradeLine } from "@/components/billing/planChangeCopy";
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
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import { planName, planPer, proPlanName } from "@/lib/pro/plans";
import type { ProPlan } from "@/lib/pro/plans";
import {
  isWebPro,
  notifyProChanged,
  useProPlans,
  useProStatus,
} from "@/lib/pro/usePro";

/** The dialog's line: today's charge for a longer period, or for a
 * shorter one "Your Pro Yearly stays on until … Pro Monthly starts then
 * at $4.99 a month." */
export function previewLine(
  p: PlanChangePreview,
  current: ProPlan | undefined,
  target: ProPlan,
  t: Tr = EN,
): string {
  const from = current ? proPlanName(current, t) : "Pro";
  const to = proPlanName(target, t);
  if (isStepDown(p)) {
    return `${stepDownLine(from, { name: to, per: planPer(target, t) }, p, t)} ${t("billing.planChange.nothingToday")}`;
  }
  return upgradeLine(p, { from, to }, t);
}

const SCOPE = "pro-period";

export function ProPeriodChange(): JSX.Element | null {
  const gateway = useGateway();
  const t = useT();
  const status = useProStatus();
  const plans = useProPlans();
  // the plan being switched to, by id (its row comes from the plans)
  const [targetId, setTarget] = useState<string | null>(null);
  const target = plans.state === "ready" ? (plans.plans.find((p) => p.id === targetId) ?? null) : null;
  const billing = useBilling();
  // ADR 0138: the preview and the confirm live in the plan change atom
  const change = useAtomValue(planChangeAtom(SCOPE));
  const previewChange = useSetAtom(previewPlanChangeAtom);
  const confirmChange = useSetAtom(confirmPlanChangeAtom);
  const closeChange = useSetAtom(closePlanChangeAtom);
  const preview = change.to === target?.id ? change.preview : null;
  const error =
    change.error ?? (change.previewFailed ? t("pro.period.previewFailed") : null);
  const notice = change.repriced ? t("billing.planChange.repriced") : null;
  const busy = change.busy;
  if (!isWebPro(status) || plans.state !== "ready") return null;
  // a step-down already waits for the period's end: Keep is on the page
  if (status?.scheduled_change) return null;
  const current = status?.plan_id ?? status?.via;
  const others = plans.plans.filter((p) => p.id !== current);
  const currentPlan = plans.plans.find((p) => p.id === current);
  if (others.length === 0) return null;

  function open(p: ProPlan): void {
    setTarget(p.id);
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
          {t("pro.period.switchTo", { name: planName(p, t) })}
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
              {t("pro.period.dialogTitle", { name: target ? planName(target, t) : "" })}
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="pro-change-preview">
              {error ??
                (preview && target
                  ? previewLine(preview, currentPlan, target, t)
                  : t("pro.period.working"))}
            </AlertDialogDescription>
            {preview && target && !error && !isStepDown(preview) ? (
              <StepUpExtras
                preview={preview}
                from={currentPlan ? proPlanName(currentPlan, t) : "Pro"}
                to={proPlanName(target, t)}
              />
            ) : null}
            {notice ? (
              <p role="status" className="text-xs text-amber-300">
                {notice}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("pro.period.keep")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={preview === null || busy}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              {preview && !isStepDown(preview)
                ? t("pro.period.confirmPay", { amount: formatCents(preview.today_cents, t) })
                : t("pro.period.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
