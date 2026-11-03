"use client";

/**
 * The plans and the Get Pro button (S3D-68). Prices are RevenueCat's
 * (lib/pro), in the buyer's currency; the checkout is RevenueCat's own
 * sheet (card, Apple Pay, Google Pay). Little text: name, intro offer,
 * price; one line under the button says how the chosen plan renews.
 */

import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { AUTH_MODE } from "@/lib/auth";
import {
  introLine,
  monthlyMicros,
  planCadence,
  planName,
  planTerms,
} from "@/lib/pro/plans";
import type { ProPlan } from "@/lib/pro/plans";
import { useBuyPro, useProPlans } from "@/lib/pro/usePro";
import { cn } from "@/lib/utils";

/** "Save 26%" on Yearly against twelve months of Monthly. */
function yearlySaving(plans: ProPlan[]): number | null {
  const m = plans.find((p) => p.kind === "monthly");
  const y = plans.find((p) => p.kind === "yearly");
  if (!m || !y || m.currency !== y.currency) return null;
  const pct = Math.round((1 - (monthlyMicros(y) ?? 0) / m.amountMicros) * 100);
  return pct >= 5 ? pct : null;
}

function useSandbox(): boolean {
  const [sandbox, setSandbox] = useState(false);
  useEffect(() => {
    if (AUTH_MODE === "mock") return;
    void import("@/lib/pro/revenuecat").then((m) => setSandbox(m.isSandbox()));
  }, []);
  return sandbox;
}

export function ProPlans({
  onPurchased,
}: {
  onPurchased: () => void;
}): JSX.Element {
  const plans = useProPlans();
  const buy = useBuyPro();
  const sandbox = useSandbox();
  const [chosen, setChosen] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (plans.state === "loading") {
    return (
      <div className="space-y-2.5" aria-busy="true" data-testid="pro-plans-loading">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-surface-2" />
        ))}
      </div>
    );
  }
  if (plans.state === "error" || plans.plans.length === 0) {
    return (
      <p data-testid="pro-plans-none" className="rounded-xl border border-edge bg-surface-1 p-4 text-fg-muted">
        {plans.state === "error"
          ? plans.message
          : "Pro isn't on sale on the web yet. Get it in Spatial Video Studio on iPhone, iPad, Mac or Vision Pro."}
      </p>
    );
  }

  const list = plans.plans;
  const selected = list.find((p) => p.id === chosen) ?? list[0];
  const saving = yearlySaving(list);

  async function getPro() {
    setBuying(true);
    setError(null);
    try {
      if ((await buy(selected)) === "purchased") onPurchased();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The purchase didn't go through.");
    } finally {
      setBuying(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="pro-plans">
      <div role="radiogroup" aria-label="Pro plans" className="space-y-2">
        {list.map((p) => {
          const on = p.id === selected.id;
          const intro = introLine(p);
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`pro-plan-${p.kind}`}
              disabled={buying}
              onClick={() => setChosen(p.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
                on
                  ? "border-primary bg-primary/10"
                  : "border-edge bg-surface-1 hover:border-primary/50",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border",
                  on ? "border-primary bg-primary text-primary-foreground" : "border-edge",
                )}
                aria-hidden="true"
              >
                {on && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-fg">{planName(p)}</span>
                  {p.kind === "yearly" && saving !== null && (
                    <span className="ll-tag-new">Save {saving}%</span>
                  )}
                </span>
                {intro !== null && (
                  <span className="block text-xs text-chart-2">{intro}</span>
                )}
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-semibold tabular-nums text-fg">
                  {p.price}
                </span>
                <span className="block text-xs text-fg-muted">{planCadence(p)}</span>
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        data-testid="pro-get"
        disabled={buying}
        onClick={() => void getPro()}
        className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-60"
      >
        {buying ? "Opening checkout…" : "Get Pro"}
      </button>
      <p className="text-center text-xs text-fg-muted">
        {planTerms(selected)}
        {sandbox && " · Test mode"}
      </p>
      {error !== null && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
