"use client";

/**
 * Quote A and Business nudge B (plans canvas, 2026-11-04), in the Make 3D
 * "Your price" panel.
 *
 * - Quote A, people without a plan, full runs that Pro makes cheaper: two
 *   options, "Pay once $X" (always selected first) and "With Pro $Y ·
 *   15% off · from $8.99 a month". Picking Pro turns the button into
 *   "Subscribe and convert", which opens the Pro sheet; nothing is bought
 *   or charged without a tap there. Hide (×) folds it away for 7 days.
 * - Business note B (no plan or Pro): in quotes of $50 or more, or runs
 *   over 10 minutes — "Business and Studio include monthly usage", this
 *   video at Business prices against the usage Business includes.
 *   Hide folds it away for 30 days.
 *
 * Prices: the quote, and /v1/pricing tier rates (tierPriceFor); RevenueCat
 * for what Pro costs.
 */

import { X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { JSX } from "react";

import { FEEDBACK_EMAIL } from "@/components/FeedbackLink";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { StepQuoteResponse } from "@/lib/api/types";
import { usePricing } from "@/lib/api/usePricing";
import { introLine, planCadence, planName } from "@/lib/pro/plans";
import type { ProPlan } from "@/lib/pro/plans";
import { useBuyPro, useProPlans } from "@/lib/pro/usePro";
import { SheetFrame } from "@/components/pay/SheetFrame";

import {
  listTotalOf,
  proPct,
  tierPriceFor,
  useDismissal,
  usePaywallEvents,
  usePlanTier,
  useViewEvent,
} from "./upsell";

/** Business nudge B's thresholds. */
export const BUSINESS_NOTE_CENTS = 5000;
export const BUSINESS_NOTE_SECONDS = 600;

export type PayMode = "once" | "pro";

/** Quote A: shown, and the prices it compares; null when it doesn't apply. */
export function useQuoteProChoice(quote: StepQuoteResponse | null): {
  list: number;
  pro: number;
} | null {
  const tier = usePlanTier();
  const pricing = usePricing();
  const { dismissed } = useDismissal("quote", 7);
  if (!quote || tier !== "none" || dismissed !== false) return null;
  // alt_prices don't apply free previews: a free run has nothing to save
  if (quote.payment_flow === "free_preview" || quote.free_previews?.free || quote.quote.amount_cents === 0) return null;
  const pro = tierPriceFor(quote, pricing, "pro");
  const list = quote.quote.amount_cents;
  if (pro === null || pro >= list) return null;
  return { list, pro };
}

function Option({
  on,
  onPick,
  title,
  sub,
  price,
  testId,
}: {
  on: boolean;
  onPick: () => void;
  title: string;
  sub?: string;
  price: string;
  testId: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      data-testid={testId}
      onClick={onPick}
      className={`flex min-h-14 w-full items-center gap-3 rounded-[10px] border px-3.5 py-2 text-left transition-colors ${
        on ? "border-primary bg-primary/10" : "border-edge hover:border-fg-muted"
      }`}
    >
      <span
        aria-hidden
        className={`size-4 shrink-0 rounded-full ${on ? "border-[5px] border-primary" : "border-[1.5px] border-fg-muted"}`}
      />
      <span className="flex flex-1 flex-col">
        <span className="text-[15px] text-fg">{title}</span>
        {sub ? <span className="text-xs text-fg-muted">{sub}</span> : null}
      </span>
      <span className="font-mono text-sm text-fg">{price}</span>
    </button>
  );
}

/** Quote A's two options. */
export function QuoteProChoice({
  quote,
  mode,
  onMode,
}: {
  quote: StepQuoteResponse;
  mode: PayMode;
  onMode: (m: PayMode) => void;
}): JSX.Element | null {
  const tier = usePlanTier();
  const pricing = usePricing();
  const choice = useQuoteProChoice(quote);
  const plans = useProPlans();
  const { dismiss } = useDismissal("quote", 7);
  useViewEvent("quote", tier, choice !== null, { variant: "choice", quote_cents: choice?.list });
  const send = usePaywallEvents("quote", tier, { variant: "choice", quote_cents: choice?.list });
  if (!choice) return null;
  const pct = proPct(pricing);
  const monthly = plans.state === "ready" ? plans.plans.find((p) => p.kind === "monthly") : undefined;
  return (
    <div data-testid="quote-pro-choice" role="radiogroup" aria-label="How to pay" className="flex flex-col gap-2">
      <Option
        testId="pay-once"
        on={mode === "once"}
        onPick={() => onMode("once")}
        title="Pay once"
        price={formatCents(choice.list)}
      />
      <Option
        testId="pay-with-pro"
        on={mode === "pro"}
        onPick={() => {
          send("click", { target: "with_pro" });
          onMode("pro");
        }}
        title="With Pro"
        sub={[pct ? `${pct}% off` : null, monthly ? `from ${monthly.price} a month` : null].filter(Boolean).join(" · ")}
        price={formatCents(choice.pro)}
      />
      <button
        type="button"
        onClick={() => {
          send("dismiss");
          onMode("once");
          dismiss();
        }}
        className="flex w-fit items-center gap-1 text-[11px] text-fg-muted hover:text-fg"
      >
        <X className="size-3" aria-hidden /> Hide this
      </button>
    </div>
  );
}

/** The Pro sheet behind "Subscribe and convert" (Quote A's pay sheet). */
export function ProCheckoutSheet({
  open,
  quote,
  onClose,
  onPayOnce,
  onPurchased,
}: {
  open: boolean;
  quote: StepQuoteResponse;
  onClose: () => void;
  onPayOnce: () => void;
  onPurchased: () => void;
}): JSX.Element | null {
  const tier = usePlanTier();
  const pricing = usePricing();
  const plans = useProPlans();
  const buy = useBuyPro();
  const choice = useQuoteProChoice(quote);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useViewEvent("quote", tier, open, { variant: "checkout", quote_cents: quote.quote.amount_cents });
  const send = usePaywallEvents("quote", tier, { variant: "checkout", quote_cents: quote.quote.amount_cents });
  if (!open) return null;
  const list = plans.state === "ready" ? plans.plans : [];
  const plan: ProPlan | undefined =
    list.find((p) => p.id === picked) ?? list.find((p) => p.kind === "monthly") ?? list[0];
  const pct = proPct(pricing);
  const listCents = choice?.list ?? quote.quote.amount_cents;
  const proCents = choice?.pro ?? tierPriceFor(quote, pricing, "pro") ?? listCents;
  const today = (p: ProPlan) => p.intro?.price ?? p.price;
  const note = (p: ProPlan) => {
    const intro = introLine(p);
    return intro ? `${intro}, then ${p.price}` : `${p.price} ${planCadence(p)}`;
  };

  async function go(): Promise<void> {
    if (!plan) return;
    setBusy(true);
    setError(null);
    send("click", { target: `continue_${plan.kind}` });
    try {
      const r = await buy(plan);
      if (r === "purchased") onPurchased();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The payment didn't go through.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SheetFrame
      open
      testId="pro-checkout"
      onClose={() => {
        send("dismiss");
        onClose();
      }}
      locked={busy}
      title="Subscribe and convert"
      subtitle={pct ? `Pro takes ${pct}% off this video and every one after.` : undefined}
      footer={
        <div className="flex flex-col gap-2">
          <Button size="lg" className="h-12 w-full" data-testid="pro-checkout-continue" disabled={!plan || busy} onClick={() => void go()}>
            Continue to payment
          </Button>
          <button
            type="button"
            data-testid="pro-checkout-pay-once"
            onClick={() => {
              send("click", { target: "pay_once" });
              onPayOnce();
            }}
            className="py-2 text-center text-sm text-primary hover:underline"
          >
            Pay once · {formatCents(listCents)}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {plans.state === "loading" ? (
          <div className="h-40 animate-pulse rounded-xl bg-surface-2" />
        ) : (
          <div role="radiogroup" aria-label="Pro plan" className="flex flex-col gap-2">
            {list.map((p) => (
              <Option
                key={p.id}
                testId={`pro-period-${p.kind}`}
                on={plan?.id === p.id}
                onPick={() => setPicked(p.id)}
                title={planName(p)}
                sub={note(p)}
                price={today(p)}
              />
            ))}
          </div>
        )}
        {plan ? (
          <dl className="flex flex-col gap-1.5 rounded-lg border border-edge p-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-fg-muted">Pro {planName(plan)}, today</dt>
              <dd className="font-mono">{today(plan)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-fg-muted">This video, at Pro prices</dt>
              <dd className="font-mono">{formatCents(proCents)}</dd>
            </div>
            <div className="flex justify-between text-emerald-400">
              <dt>You save on this video</dt>
              <dd className="font-mono">{formatCents(Math.max(0, listCents - proCents))}</dd>
            </div>
          </dl>
        ) : null}
        <p className="text-xs text-fg-muted">Cancel any time in Account. Prices in USD, excl. tax.</p>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
      </div>
    </SheetFrame>
  );
}

/** Business nudge B: in a large quote (≥ $50, or over 10 minutes). */
export function BusinessNote({ quote }: { quote: StepQuoteResponse }): JSX.Element | null {
  const tier = usePlanTier();
  const pricing = usePricing();
  const { dismissed, dismiss } = useDismissal("business_note", 30);
  const biz = pricing?.plans?.business;
  const studio = pricing?.plans?.studio;
  const large =
    listTotalOf(quote) >= BUSINESS_NOTE_CENTS ||
    (quote.output_seconds ?? quote.quote.breakdown?.billable_seconds ?? 0) > BUSINESS_NOTE_SECONDS;
  const bizPrice = tierPriceFor(quote, pricing, "business");
  const studioPrice = tierPriceFor(quote, pricing, "studio");
  const show =
    (tier === "none" || tier === "pro") && dismissed === false && large && !!biz && bizPrice !== null;
  useViewEvent("business_note", tier, show, { quote_cents: listTotalOf(quote) });
  const send = usePaywallEvents("business_note", tier, { quote_cents: listTotalOf(quote) });
  if (!show || !biz || bizPrice === null) return null;
  const fits = bizPrice <= biz.credit_cents;
  return (
    <div data-testid="business-note" className="flex flex-col gap-2 rounded-lg border border-edge bg-surface-2 p-3 text-xs">
      <div className="flex items-start gap-2">
        <p className="flex-1 font-medium text-fg">Business and Studio include monthly usage.</p>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            send("dismiss");
            dismiss();
          }}
          className="text-fg-muted hover:text-fg"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <p className="text-fg-muted">
        At Business prices this video is {formatCents(bizPrice)}.
        {fits
          ? ` That fits in the ${formatCentsShort(biz.credit_cents)} of usage Business includes every month, for ${formatCentsShort(biz.price_cents ?? biz.monthly_cents)} a month.`
          : ` Business includes ${formatCentsShort(biz.credit_cents)} of usage every month, for ${formatCentsShort(biz.price_cents ?? biz.monthly_cents)} a month.`}
        {studio && studioPrice !== null ? ` With Studio it's ${formatCents(studioPrice)}.` : ""}
      </p>
      <div className="flex gap-3">
        <Link href="/plans" onClick={() => send("click", { target: "/plans" })} className="text-primary hover:underline">
          See Business
        </Link>
        <a
          href={`mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent("Spatial Video Studio Business")}`}
          onClick={() => send("click", { target: "talk" })}
          className="text-primary hover:underline"
        >
          Talk to us
        </a>
      </div>
    </div>
  );
}
