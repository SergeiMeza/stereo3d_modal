"use client";

/**
 * Receipt A (plans canvas, 2026-11-04): after a full run is billed, "You'd
 * have saved $4.50 with Pro" — only when that saving is above zero and the
 * person has no plan. The saving is this run's price against the same run
 * at Pro's rate (/v1/pricing tier rates). "Not now" hides it for 7 days
 * (kept on the account).
 */

import Link from "next/link";
import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { Project, StepQuoteResponse } from "@/lib/api/types";
import { usePricing } from "@/lib/api/usePricing";
import { useProPlans } from "@/lib/pro/usePro";

import { tierPriceFor, useDismissal, usePaywallEvents, usePlanTier, useViewEvent } from "./upsell";

export function ProSavingsCard({ project }: { project: Project }): JSX.Element | null {
  const tier = usePlanTier();
  const pricing = usePricing();
  const plans = useProPlans();
  const { dismissed, dismiss } = useDismissal("receipt", 7);
  const run = [...(project.conversions ?? [])]
    .filter(
      (c) =>
        c.step === "production" &&
        c.state === "succeeded" &&
        (c.billing?.status === "charged" || c.billing?.status === "balance_settled") &&
        c.quote.amount_cents > 0,
    )
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  const pro = run
    ? tierPriceFor(
        {
          step: "production",
          params: run.params,
          quote: run.quote,
          // the run's own alt_prices when the gateway kept them; else composed
          alt_prices: (run as { alt_prices?: StepQuoteResponse["alt_prices"] }).alt_prices,
        } as StepQuoteResponse,
        pricing,
        "pro",
      )
    : null;
  const saved = run && pro !== null ? run.quote.amount_cents - pro : 0;
  const show = tier === "none" && dismissed === false && !!run && pro !== null && saved > 0;
  const quoteCents = run?.quote.amount_cents;
  useViewEvent("receipt", tier, show, { variant: "pro_saving", quote_cents: quoteCents });
  const send = usePaywallEvents("receipt", tier, { variant: "pro_saving", quote_cents: quoteCents });
  if (!show || pro === null) return null;
  const monthly = plans.state === "ready" ? plans.plans.find((p) => p.kind === "monthly") : undefined;
  const previews = pricing?.free_previews?.allowances?.pro_monthly;
  return (
    <section
      data-testid="receipt-pro"
      className="flex flex-col gap-2 rounded-xl border border-primary/40 bg-primary/5 p-4 text-sm"
    >
      <p className="font-semibold text-fg">You&apos;d have saved {formatCents(saved)} with Pro</p>
      <p className="text-fg-muted">
        This video would have been {formatCents(pro)}.
        {monthly
          ? ` Pro Monthly is ${monthly.price}${typeof previews === "number" && previews > 0 ? ` and includes ${previews} free previews a month` : ""}.`
          : ""}
      </p>
      <div className="flex gap-2">
        <Button asChild size="sm">
          <Link href="/pro" onClick={() => send("click", { target: "/pro" })}>
            See Pro
          </Link>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            send("dismiss");
            dismiss();
          }}
        >
          Not now
        </Button>
      </div>
    </section>
  );
}
