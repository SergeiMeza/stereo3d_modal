"use client";

/**
 * Business or Studio for a web Pro member (coordinator 2026-11-05), or the
 * other team plan for a Business or Studio member (owner bug 2026-11-05:
 * Choose Studio on Business did nothing): a plan change, not a new plan
 * checkout. A step-up is paid now; a step-down (Studio → Business) waits
 * for the end of the paid period and charges nothing today. POST /v1/plans/preview-change prices
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
import {
  changeDate,
  isStepDown,
  nextPlanLine,
  NOTHING_TODAY,
  REPRICED,
  stepDownLine,
  upgradeLine,
} from "@/components/billing/planChangeCopy";
import { planPrice } from "@/components/pricing/planCopy";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { SheetFrame } from "@/components/ui/sheet-frame";
import type { PlanDef } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { awaitPlanCredit } from "@/lib/billing";
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
  handoverCreditCents,
  onClose,
}: {
  plan: "business" | "studio";
  def: PlanDef;
  /** what it replaces ("Pro Monthly", "Business") */
  from: string;
  /** between team plans: the new plan's monthly usage (the hand-over line) */
  handoverCreditCents?: number | null;
  onClose: (changed: boolean) => void;
}): JSX.Element {
  const gateway = useGateway();
  const change = useAtomValue(planChangeAtom(SCOPE));
  const preview = useSetAtom(previewPlanChangeAtom);
  const confirm = useSetAtom(confirmPlanChangeAtom);
  const close = useSetAtom(closePlanChangeAtom);
  const [done, setDone] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void preview({ scope: SCOPE, client: gateway, to: plan });
    return () => {
      close(SCOPE);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [preview, close, gateway, plan]);

  const p = change.to === plan ? change.preview : null;
  const down = p !== null && isStepDown(p);
  const price = planPrice(def);
  const title = `${def.name} · ${formatCentsShort(price.cents)} ${price.per}`;

  async function pay(): Promise<void> {
    if ((await confirm({ scope: SCOPE, client: gateway })) !== "done") return;
    // the gateway reads the Pro state again right after
    void gateway.refreshPro().catch(() => {});
    notifyProChanged();
    // the new plan's usage lands a moment later: read until it shows
    void awaitPlanCredit();
    setDone(
      down && p
        ? nextPlanLine(from, p.effective_at, { name: def.name, per: price.per, cents: p.new_plan_cents })
        : planStarted(def),
    );
    timer.current = setTimeout(() => onClose(true), SUCCESS_CLOSE_MS);
  }

  if (done !== null) {
    return (
      <SheetFrame open onClose={() => onClose(true)} testId="plan-change-sheet" title={title}>
        <Success text={done} />
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
          lines={down ? [NOTHING_TODAY] : [CHARGED_IN_USD]}
          button={
            <Button
              size="lg"
              data-testid="plan-change-main"
              className="h-12 w-full text-base tabular-nums"
              disabled={p === null || change.busy}
              onClick={() => void pay()}
            >
              {change.busy
                ? "Changing…"
                : p && change.error
                  ? "Try again"
                  : p
                    ? down
                      ? `Change to ${def.name} on ${p.effective_at ? changeDate(p.effective_at) : "renewal"}`
                      : `Pay ${formatCents(p.today_cents)} and change`
                    : error
                      ? "Can't change right now"
                      : "Working it out…"}
            </Button>
          }
        />
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {error ? (
          <>
            <StateLine testId="plan-change-error" text={error} />
            {change.previewFailed ? (
              <Button
                variant="outline"
                size="sm"
                data-testid="plan-change-retry"
                className="w-fit"
                onClick={() => void preview({ scope: SCOPE, client: gateway, to: plan })}
              >
                Try again
              </Button>
            ) : null}
          </>
        ) : p && down ? (
          <p data-testid="plan-change-line" className="text-fg">
            {stepDownLine(from, { name: def.name, per: price.per }, p)} {NOTHING_TODAY}
          </p>
        ) : p ? (
          <>
            <p data-testid="plan-change-line" className="text-fg">
              {upgradeLine(p, { from, to: def.name })}
            </p>
            <StepUpExtras preview={p} from={from} to={def.name} handoverCreditCents={handoverCreditCents ?? null} />
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
