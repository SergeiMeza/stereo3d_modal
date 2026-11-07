"use client";

/**
 * The plans and the Get Pro button (S3D-68). Prices are GET /v1/pricing
 * pro_plans (gateway 00102, USD); Get Pro opens our own payment sheet
 * (ProCheckoutHost). Little text: name, the credit to start, price; one line under
 * the button says how the chosen plan renews.
 */

import { Check } from "lucide-react";
import { useState } from "react";
import type { JSX } from "react";

import { LocalPriceNote } from "@/components/pro/LocalPriceNote";
import { useT } from "@/lib/i18n/I18nProvider";
import {
  bestValuePlan,
  creditShort,
  defaultPlan,
  monthlyMicros,
  pageOrder,
  perMonthLine,
  planCadence,
  planName,
  planTerms,
} from "@/lib/pro/plans";
import { SITE_NAME } from "@/lib/site";
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

export function ProPlans({
  onPurchased,
}: {
  onPurchased: () => void;
}): JSX.Element {
  const plans = useProPlans();
  const t = useT();
  const buy = useBuyPro();
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
          ? plans.message || t("pro.plans.loadFailed")
          : t("pro.list.notOnSale", { app: SITE_NAME })}
      </p>
    );
  }

  // owner 2026-11-07 (BUX-10): Yearly first and chosen, "Best value" on
  // the plan that costs least per month, per-month prices beside the rest
  const list = pageOrder(plans.plans);
  const selected = list.find((p) => p.id === chosen) ?? defaultPlan(list) ?? list[0];
  const saving = yearlySaving(list);
  const best = bestValuePlan(list);

  async function getPro() {
    setBuying(true);
    setError(null);
    try {
      if ((await buy(selected)) === "purchased") onPurchased();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("pro.list.purchaseFailed"));
    } finally {
      setBuying(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="pro-plans">
      <div role="radiogroup" aria-label={t("pro.list.ariaLabel")} className="space-y-2">
        {list.map((p) => {
          const on = p.id === selected.id;
          const credit = creditShort(p.creditCents, t);
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
                "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-start transition-colors",
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
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{planName(p, t)}</span>
                  {best?.id === p.id && (
                    <span data-testid={`pro-plan-best-${p.kind}`} className="ll-tag-new">
                      {t("pro.list.bestValue")}
                    </span>
                  )}
                  {p.kind === "yearly" && saving !== null && (
                    <span className="ll-tag-new">{t("pro.list.save", { pct: saving })}</span>
                  )}
                </span>
                {/* owner 2026-11-07: the credit joining Pro gives, from /v1/pricing */}
                {credit !== null && (
                  <span data-testid={`pro-plan-credit-${p.kind}`} className="block text-xs text-chart-2">
                    {t("pro.list.creditPlus", { credit })}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-end">
                <span className="block font-semibold tabular-nums text-fg">
                  {p.price}
                </span>
                <span className="block text-xs text-fg-muted">{planCadence(p, t)}</span>
                {perMonthLine(p, t) !== null && (
                  <span data-testid={`pro-plan-per-month-${p.kind}`} className="block text-xs tabular-nums text-fg-muted">
                    {perMonthLine(p, t)}
                  </span>
                )}
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
        {buying ? t("pro.list.opening") : t("pro.list.getPro")}
      </button>
      <p className="text-center text-xs text-fg-muted">{planTerms(selected, t)}</p>
      <LocalPriceNote testId="pro-local-note" className="text-center" />
      {error !== null && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
