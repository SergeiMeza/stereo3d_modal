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

const PLAN_KEYS = ["business", "studio"] as const;
type PlanKey = (typeof PLAN_KEYS)[number];

/** The few lines a plan card shows. */
export function planLines(def: PlanDef, pct: number | undefined): string[] {
  return [
    `${formatCentsShort(def.credit_cents)} of usage every month`,
    ...(pct ? [`${Math.round(pct * 100)}% off every run`] : []),
    // owner 2026-11-04: Terms "Using your 3D outputs"
    "Commercial use of your videos",
    `${def.free_previews_per_period} free previews a month`,
    ...(def.express_included ? ["Express included"] : []),
    // owner 2026-11-04: above 30 fps comes with a plan
    ...(def.max_fps && def.max_fps > 30 ? [`Up to ${def.max_fps} fps`] : []),
    `${def.seats} people · invoices`,
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
          Plans for teams
        </h2>
        <p className="mt-1 text-sm text-fg-muted">Usage included every month. Cancel any time.</p>
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
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatCentsShort(def.monthly_cents)}
                  <span className="text-sm font-normal text-fg-muted"> a month</span>
                </p>
              </div>
              <ul className="flex flex-col gap-2 text-sm">
                {planLines(def, pct).map((l) => (
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
