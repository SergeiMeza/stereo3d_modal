"use client";

/**
 * A web Pro (our own Stripe subscription) changes its period here (owner
 * 2026-11-04): POST /v1/plans/preview-change {to} first — "Today: $X (new
 * plan $A − $B for your unused Pro days). Renews on <date>" — then POST
 * /v1/plans/change {to, confirm: true}. Nothing is charged before
 * confirm.
 */

import { useState } from "react";
import type { JSX } from "react";

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
import { GatewayError } from "@/lib/api/client";
import type { PlanChangePreview } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { planName } from "@/lib/pro/plans";
import type { ProPlan } from "@/lib/pro/plans";
import { notifyProChanged, useProPlans, useProStatus } from "@/lib/pro/usePro";

/** "Today: $X (new plan $A − $B for your unused Pro days). Renews on 4 Dec 2026." */
export function previewLine(p: PlanChangePreview): string {
  const renews = new Date(p.renews_at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `Today: ${formatCents(p.today_cents)} (new plan ${formatCents(p.new_plan_cents)} − ${formatCents(
    p.unused_credit_cents,
  )} for your unused Pro days). Renews on ${renews}.`;
}

export function ProPeriodChange(): JSX.Element | null {
  const gateway = useGateway();
  const status = useProStatus();
  const plans = useProPlans();
  const [target, setTarget] = useState<ProPlan | null>(null);
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (status?.source !== "stripe" || plans.state !== "ready") return null;
  const current = status.via;
  const others = plans.plans.filter(
    (p) => p.billing === "stripe" && p.id !== current,
  );
  if (others.length === 0) return null;

  function open(p: ProPlan): void {
    setTarget(p);
    setPreview(null);
    setError(null);
    gateway
      .previewPlanChange(p.id)
      .then(setPreview, () =>
        setError("Couldn't work out the price. Nothing was charged."),
      );
  }

  async function confirm(): Promise<void> {
    if (!target) return;
    setBusy(true);
    try {
      await gateway.changePlan(target.id);
      void gateway.refreshPro().catch(() => {});
      notifyProChanged();
      setTarget(null);
    } catch (e) {
      setError(
        e instanceof GatewayError && e.message
          ? e.message
          : "Couldn't change your plan. Nothing was charged.",
      );
    } finally {
      setBusy(false);
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
        onOpenChange={(o) => !o && setTarget(null)}
      >
        <AlertDialogContent data-testid="pro-change-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch to Pro {target ? planName(target) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="pro-change-preview">
              {error ??
                (preview ? previewLine(preview) : "Working out today's price…")}
            </AlertDialogDescription>
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
              {preview
                ? `Confirm and pay ${formatCents(preview.today_cents)}`
                : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
