"use client";

/**
 * Business or Studio for a web Pro member (coordinator 2026-11-05): a plan
 * change, not a new plan checkout. POST /v1/plans/preview-change prices
 * it (today's amount: the plan less our credit for the unused Pro) and
 * POST /v1/plans/change with that quote makes it, at once, on the saved
 * payment method, so nobody pays twice. The same plan change atom as
 * Billing's "Change plan" (planChangeAtoms): latest preview wins, an
 * expired quote is priced again and waits for a second confirm.
 */

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { StepUpExtras } from "@/components/billing/StepUpDetails";
import {
  closePlanChangeAtom,
  confirmPlanChangeAtom,
  planChangeAtom,
  previewPlanChangeAtom,
} from "@/components/billing/planChangeAtoms";
import { REPRICED, upgradeLine } from "@/components/billing/planChangeCopy";
import { planPrice } from "@/components/pricing/planCopy";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { SheetFrame } from "@/components/ui/sheet-frame";
import type { PlanDef } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";
import { notifyProChanged } from "@/lib/pro/usePro";

import { MainButtonArea, StateLine, Success, SUCCESS_CLOSE_MS } from "./PaySheet";
import { planStarted } from "./PlanSheet";
import { CHARGED_IN_USD } from "./payCopy";

const SCOPE = "plans-section";

export const PREVIEW_FAILED = "Couldn't work out the change. Nothing was charged.";

export function PlanChangeSheet({
  plan,
  def,
  from,
  onClose,
}: {
  plan: "business" | "studio";
  def: PlanDef;
  /** the Pro it replaces ("Pro Monthly") */
  from: string;
  onClose: (changed: boolean) => void;
}): JSX.Element {
  const gateway = useGateway();
  const billing = useBilling();
  const change = useAtomValue(planChangeAtom(SCOPE));
  const preview = useSetAtom(previewPlanChangeAtom);
  const confirm = useSetAtom(confirmPlanChangeAtom);
  const close = useSetAtom(closePlanChangeAtom);
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void preview({ scope: SCOPE, client: gateway, to: plan });
    return () => {
      close(SCOPE);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [preview, close, gateway, plan]);

  const p = change.to === plan ? change.preview : null;
  const price = planPrice(def);
  const title = `${def.name} · ${formatCentsShort(price.cents)} ${price.per}`;

  async function pay(): Promise<void> {
    if ((await confirm({ scope: SCOPE, client: gateway })) !== "done") return;
    // the gateway reads the Pro state again right after
    void gateway.refreshPro().catch(() => {});
    notifyProChanged();
    void billing.refresh();
    setDone(true);
    timer.current = setTimeout(() => onClose(true), SUCCESS_CLOSE_MS);
  }

  if (done) {
    return (
      <SheetFrame open onClose={() => onClose(true)} testId="plan-change-sheet" title={title}>
        <Success text={planStarted(def)} />
      </SheetFrame>
    );
  }

  const error = change.error ?? (change.previewFailed && change.to === plan ? PREVIEW_FAILED : null);
  return (
    <SheetFrame
      open
      onClose={() => onClose(false)}
      locked={change.busy}
      testId="plan-change-sheet"
      title={title}
      subtitle={`Instead of your ${from}`}
      footer={
        <MainButtonArea
          lines={[CHARGED_IN_USD]}
          button={
            <Button
              size="lg"
              data-testid="plan-change-main"
              className="h-12 w-full text-base tabular-nums"
              disabled={p === null || change.busy}
              onClick={() => void pay()}
            >
              {change.busy ? "Changing…" : p ? `Pay ${formatCents(p.today_cents)} and change` : "Working it out…"}
            </Button>
          }
        />
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {error ? (
          <StateLine testId="plan-change-error" text={error} />
        ) : p ? (
          <>
            <p data-testid="plan-change-line" className="text-fg">
              {upgradeLine(p, { from, to: def.name })}
            </p>
            <StepUpExtras preview={p} from={from} to={def.name} />
          </>
        ) : (
          <div data-testid="pay-skeleton" className="h-16 animate-pulse rounded-lg bg-surface-2" />
        )}
        {change.repriced ? (
          <p role="status" className="text-xs text-amber-300">
            {REPRICED}
          </p>
        ) : null}
      </div>
    </SheetFrame>
  );
}
