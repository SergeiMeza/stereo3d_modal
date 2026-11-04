"use client";

/**
 * Business and Studio plans (pricing 2026-11, BL-19): a monthly fee with
 * that much usage included at the plan's own prices, free previews and
 * Express. Every number comes from GET /v1/pricing; Choose opens our
 * payment sheet (PlanSheet).
 */

import { CheckIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { JSX } from "react";

import { PlanSheet } from "@/components/pay/PlanSheet";
import { formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { PlanDef, PublicPricing } from "@/lib/api/types";
import { useAuth } from "@/lib/auth";
import { useBilling } from "@/lib/billing";

import { planPrice } from "./planCopy";

const PLAN_KEYS = ["business", "studio"] as const;
type PlanKey = (typeof PLAN_KEYS)[number];

/** The few lines a plan card shows. */
export function planLines(def: PlanDef, pct: number | undefined, maxFpsWithPlan?: number): string[] {
  // the plan's own max_fps, else /v1/pricing fps.max_fps_with_plan (test
  // gateway 00091 sends only the latter)
  const maxFps = def.max_fps ?? maxFpsWithPlan;
  return [
    `${formatCentsShort(def.credit_cents)} of usage every month`,
    ...(pct ? [`${Math.round(pct * 100)}% off every run`] : []),
    // owner 2026-11-04: Terms "Using your 3D outputs"
    "Commercial use of your videos",
    `${def.free_previews_per_period} free previews a month`,
    ...(def.express_included ? ["Express included"] : []),
    // owner 2026-11-04: above 30 fps comes with a plan
    ...(maxFps && maxFps > 30 ? [`Up to ${maxFps} fps`] : []),
    // owner 2026-11-04: no seat counts until team accounts exist
    "Invoices",
  ];
}

export function PlansSection({ pricing }: { pricing: PublicPricing }): JSX.Element | null {
  const { user } = useAuth();
  const billing = useBilling();
  const [open, setOpen] = useState<PlanKey | null>(null);
  const plans = pricing.plans;
  if (!plans || PLAN_KEYS.every((k) => !plans[k])) return null;
  const mine = billing.status?.plan?.active ? billing.status.plan.plan : null;
  return (
    <section data-testid="plans" aria-labelledby="plans-title" className="flex flex-col gap-4">
      <div className="text-center">
        <h2 id="plans-title" className="text-lg font-semibold tracking-tight">
          Plans for work
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          Usage included every month. Business bills monthly, Studio yearly.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {PLAN_KEYS.map((k) => {
          const def = plans[k];
          if (!def) return null;
          const pct = pricing.tiers?.classic_pct?.[k];
          return (
            <div
              key={k}
              data-testid={`plan-${k}`}
              className={`flex flex-col gap-4 rounded-xl border bg-card p-6 ${
                k === "studio" ? "border-primary/50" : "border-edge"
              }`}
            >
              <div>
                <h3 className="text-base font-semibold">{def.name}</h3>
                <p data-testid={`plan-price-${k}`} className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatCentsShort(planPrice(def).cents)}
                  <span className="text-sm font-normal text-fg-muted"> {planPrice(def).per}</span>
                </p>
              </div>
              <ul className="flex flex-col gap-2 text-sm">
                {planLines(def, pct, pricing.fps.max_fps_with_plan).map((l) => (
                  <li key={l} className="flex items-center gap-2">
                    <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />
                    {l}
                  </li>
                ))}
              </ul>
              {mine === k ? (
                <Button variant="outline" disabled className="mt-auto w-full">
                  Your plan
                </Button>
              ) : user ? (
                <Button
                  data-testid={`choose-${k}`}
                  variant={k === "studio" ? "default" : "outline"}
                  className="mt-auto w-full"
                  disabled={mine !== null}
                  onClick={() => setOpen(k)}
                >
                  Choose {def.name}
                </Button>
              ) : (
                <Button asChild variant={k === "studio" ? "default" : "outline"} className="mt-auto w-full">
                  <Link href="/signin?next=/pricing">Choose {def.name}</Link>
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {open && plans[open] ? (
        <PlanSheet plan={open} def={plans[open]!} onClose={() => setOpen(null)} />
      ) : null}
    </section>
  );
}
