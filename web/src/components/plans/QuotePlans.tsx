"use client";

/**
 * Quote A and Business nudge B (plans canvas, 2026-11-04), in the Make 3D
 * "Your price" panel.
 *
 * - Quote A, people without a plan, full runs that Pro makes cheaper: two
 *   options, "Pay once $X" (always selected first) and "With Pro $Y ·
 *   15% off · from $4.99 a month". Picking Pro turns the button into
 *   "Get the plan and convert", which opens the Pro sheet; nothing is bought
 *   or charged without a tap there. Hide (×) folds it away for 7 days.
 * - Business note B (no plan or Pro): in quotes of $50 or more, or runs
 *   over 10 minutes — "Business and Studio include monthly usage", this
 *   video at Business prices against the usage Business includes.
 *   Hide folds it away for 30 days. High-end sources (above 4K, or above
 *   30 fps; owner 2026-11-04) bring it too, dismissed once per project.
 * - Cinema prices: a 5K–8K quote lists the Business and Studio prices
 *   from the quote's alt_prices beside Pay once (which stays selected).
 *
 * Prices: the quote, and /v1/pricing tier rates (tierPriceFor) and
 * pro_plans for what Pro costs.
 */

import { X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { JSX } from "react";

import { FEEDBACK_EMAIL } from "@/lib/contact";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { Probe, StepQuoteResponse } from "@/lib/api/types";
import { usePricing } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";
import { creditLine, creditRules, creditShort, planCadence, planName, proCreditCents, proCreditDays } from "@/lib/pro/plans";
import type { ProPlan } from "@/lib/pro/plans";
import { useBuyPro, useProPlans } from "@/lib/pro/usePro";
import { SheetFrame } from "@/components/pay/SheetFrame";

import type { SurfaceReason } from "./upsell";
import {
  businessSaveRange,
  cinemaTierPrices,
  listTotalOf,
  proPct,
  sourceReason,
  tierPriceFor,
  useDismissal,
  useProjectDismissal,
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
  // alt_prices don't apply free previews: a free run has nothing to save.
  // free_previews.free speaks for previews only: the gateway sends it on
  // every quote, and for a new account it says the first preview is free
  // on the full run's quote too (TEST 2026-11-07: the Pro row hid on a new
  // account's first quote, and showed once the free preview was used).
  if (
    quote.payment_flow === "free_preview" ||
    (quote.step === "lifelike_preview" && quote.free_previews?.free) ||
    quote.quote.amount_cents === 0
  )
    return null;
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
      className={`flex min-h-14 w-full items-center gap-3 rounded-[10px] border px-3.5 py-2 text-start transition-colors ${
        on
          ? "border-primary bg-primary/10"
          : "border-edge hover:border-fg-muted"
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
  const t = useT();
  const tier = usePlanTier();
  const pricing = usePricing();
  const choice = useQuoteProChoice(quote);
  const plans = useProPlans();
  const { dismiss } = useDismissal("quote", 7);
  useViewEvent("quote", tier, choice !== null, {
    variant: "choice",
    quote_cents: choice?.list,
  });
  const send = usePaywallEvents("quote", tier, {
    variant: "choice",
    quote_cents: choice?.list,
  });
  if (!choice) return null;
  const pct = proPct(pricing);
  const credit = proCreditCents(pricing);
  const monthly =
    plans.state === "ready"
      ? plans.plans.find((p) => p.kind === "monthly")
      : undefined;
  return (
    <div
      data-testid="quote-pro-choice"
      role="radiogroup"
      aria-label={t("plans.quote.howToPay")}
      className="flex flex-col gap-2"
    >
      <Option
        testId="pay-once"
        on={mode === "once"}
        onPick={() => onMode("once")}
        title={t("plans.quote.payOnce")}
        price={formatCents(choice.list, t)}
      />
      <Option
        testId="pay-with-pro"
        on={mode === "pro"}
        onPick={() => {
          send("click", { target: "with_pro" });
          onMode("pro");
        }}
        title={t("plans.quote.withPlan", { plan: "Pro" })}
        sub={[
          pct ? t("plans.quote.pctOff", { pct }) : null,
          // owner 2026-11-07: the credit joining Pro gives
          creditShort(credit, t),
          monthly ? t("plans.quote.fromMonthly", { price: monthly.price }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        price={formatCents(choice.pro, t)}
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
        <X className="size-3" aria-hidden /> {t("plans.quote.hide")}
      </button>
    </div>
  );
}

/** The Pro sheet behind "Get the plan and convert" (Quote A's pay sheet). */
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
  const t = useT();
  const tier = usePlanTier();
  const pricing = usePricing();
  const plans = useProPlans();
  const buy = useBuyPro();
  const choice = useQuoteProChoice(quote);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useViewEvent("quote", tier, open, {
    variant: "checkout",
    quote_cents: quote.quote.amount_cents,
  });
  const send = usePaywallEvents("quote", tier, {
    variant: "checkout",
    quote_cents: quote.quote.amount_cents,
  });
  if (!open) return null;
  const list = plans.state === "ready" ? plans.plans : [];
  const plan: ProPlan | undefined =
    list.find((p) => p.id === picked) ??
    list.find((p) => p.kind === "monthly") ??
    list[0];
  const pct = proPct(pricing);
  const listCents = choice?.list ?? quote.quote.amount_cents;
  const proCents =
    choice?.pro ?? tierPriceFor(quote, pricing, "pro") ?? listCents;
  const today = (p: ProPlan) => p.price;
  const note = (p: ProPlan) => `${p.price} ${planCadence(p, t)}`;
  const credit = creditLine(proCreditCents(pricing), t);

  async function go(): Promise<void> {
    if (!plan) return;
    setBusy(true);
    setError(null);
    send("click", { target: `continue_${plan.kind}` });
    try {
      const r = await buy(plan);
      if (r === "purchased") onPurchased();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("plans.quote.checkout.paymentFailed"),
      );
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
      title={t("plans.quote.checkout.title")}
      subtitle={
        pct
          ? credit
            ? t("plans.quote.checkout.takesOffWithCredit", { pro: "Pro", pct, credit })
            : t("plans.quote.checkout.takesOff", { pro: "Pro", pct })
          : credit
            ? t("plans.quote.checkout.includes", { pro: "Pro", credit })
            : undefined
      }
      footer={
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            className="h-12 w-full"
            data-testid="pro-checkout-continue"
            disabled={!plan || busy}
            onClick={() => void go()}
          >
            {t("plans.quote.checkout.continue")}
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
            {t("plans.quote.checkout.payOnce", { price: formatCents(listCents, t) })}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {plans.state === "loading" ? (
          <div className="h-40 animate-pulse rounded-xl bg-surface-2" />
        ) : (
          <div
            role="radiogroup"
            aria-label={t("plans.quote.checkout.planGroup", { pro: "Pro" })}
            className="flex flex-col gap-2"
          >
            {list.map((p) => (
              <Option
                key={p.id}
                testId={`pro-period-${p.kind}`}
                on={plan?.id === p.id}
                onPick={() => setPicked(p.id)}
                title={planName(p, t)}
                sub={note(p)}
                price={today(p)}
              />
            ))}
          </div>
        )}
        {plan ? (
          <dl className="flex flex-col gap-1.5 rounded-lg border border-edge p-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-fg-muted">
                {t("plans.quote.checkout.today", { pro: "Pro", plan: planName(plan, t) })}
              </dt>
              <dd className="font-mono">{today(plan)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-fg-muted">{t("plans.quote.checkout.thisVideo", { pro: "Pro" })}</dt>
              <dd className="font-mono">{formatCents(proCents, t)}</dd>
            </div>
            <div className="flex justify-between text-emerald-400">
              <dt>{t("plans.quote.checkout.youSave")}</dt>
              <dd className="font-mono">
                {formatCents(Math.max(0, listCents - proCents), t)}
              </dd>
            </div>
          </dl>
        ) : null}
        <p className="text-xs text-fg-muted">
          {credit ? `${creditRules(proCreditDays(pricing), t)} ` : ""}
          {t("plans.quote.checkout.termsNoTax")}
        </p>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
      </div>
    </SheetFrame>
  );
}

/** Why the Business note shows for this quote, or null. */
export function businessNoteReason(
  quote: StepQuoteResponse,
  probe: Probe | undefined,
): SurfaceReason | null {
  if (listTotalOf(quote) >= BUSINESS_NOTE_CENTS) return "quote_size";
  if (
    (quote.output_seconds ?? quote.quote.breakdown?.billable_seconds ?? 0) >
    BUSINESS_NOTE_SECONDS
  )
    return "run_length";
  // a 5K–8K quote already lists the Business and Studio prices
  if (cinemaTierPrices(quote)) return null;
  return sourceReason(probe);
}

/** Business nudge B: in a large quote (≥ $50, or over 10 minutes), or for
 * a source above 4K or above 30 fps. */
export function BusinessNote({
  quote,
  projectId = "",
  probe,
}: {
  quote: StepQuoteResponse;
  projectId?: string;
  probe?: Probe;
}): JSX.Element | null {
  const t = useT();
  const tier = usePlanTier();
  const pricing = usePricing();
  const account = useDismissal("business_note", 30);
  const perProject = useProjectDismissal(projectId);
  const biz = pricing?.plans?.business;
  const studio = pricing?.plans?.studio;
  const reason = businessNoteReason(quote, probe);
  const fromSource = reason === "source_8k" || reason === "source_fps";
  const dismissed = fromSource ? perProject.dismissed : account.dismissed;
  const dismiss = fromSource ? perProject.dismiss : account.dismiss;
  const bizPrice = tierPriceFor(quote, pricing, "business");
  const studioPrice = tierPriceFor(quote, pricing, "studio");
  const show =
    (tier === "none" || tier === "pro") &&
    dismissed === false &&
    reason !== null &&
    !!biz &&
    bizPrice !== null;
  const base = {
    quote_cents: listTotalOf(quote),
    ...(reason ? { reason } : {}),
  };
  useViewEvent("business_note", tier, show, base);
  const send = usePaywallEvents("business_note", tier, base);
  if (!show || !biz || bizPrice === null) return null;
  const fits = bizPrice <= biz.credit_cents;
  const usage = {
    business: "Business",
    credit: formatCentsShort(biz.credit_cents, t),
    price: formatCentsShort(biz.price_cents ?? biz.monthly_cents, t),
  };
  return (
    <div
      data-testid="business-note"
      className="flex flex-col gap-2 rounded-lg border border-edge bg-surface-2 p-3 text-xs"
    >
      <div className="flex items-start gap-2">
        <p className="flex-1 font-medium text-fg">
          {reason === "source_fps"
            ? t("plans.quote.note.highFps", { business: "Business", studio: "Studio" })
            : t("plans.quote.note.monthlyUsage", { business: "Business", studio: "Studio" })}
        </p>
        <button
          type="button"
          aria-label={t("plans.quote.note.dismiss")}
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
        {t("plans.quote.note.atBusiness", { business: "Business", price: formatCents(bizPrice, t) })}
        {` ${fits ? t("plans.quote.note.fits", usage) : t("plans.quote.note.includes", usage)}`}
        {studio && studioPrice !== null
          ? ` ${t("plans.quote.note.withStudio", { studio: "Studio", price: formatCents(studioPrice, t) })}`
          : ""}
      </p>
      <div className="flex gap-3">
        <Link
          href="/plans"
          onClick={() => send("click", { target: "/plans" })}
          className="text-primary hover:underline"
        >
          {t("plans.quote.note.seeBusiness", { business: "Business" })}
        </Link>
        <a
          href={`mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent("Spatial Video Studio Business")}`}
          onClick={() => send("click", { target: "talk" })}
          className="text-primary hover:underline"
        >
          {t("plans.quote.note.talk")}
        </a>
      </div>
    </div>
  );
}

/** A 5K–8K quote: Business and Studio prices beside Pay once, from the
 * quote's alt_prices (never composed). Pay once stays selected; See
 * Business opens the plans. No plan or Pro only; dismissed per project. */
export function CinemaTierPrices({
  quote,
  projectId,
}: {
  quote: StepQuoteResponse;
  projectId: string;
}): JSX.Element | null {
  const t = useT();
  const tier = usePlanTier();
  const pricing = usePricing();
  const { dismissed, dismiss } = useProjectDismissal(projectId);
  const prices = cinemaTierPrices(quote);
  const range = businessSaveRange(pricing);
  const pct = pricing?.tiers?.classic_pct;
  const show =
    (tier === "none" || tier === "pro") && !dismissed && prices !== null;
  const base = {
    variant: "tier_prices",
    reason: "source_8k" as const,
    quote_cents: listTotalOf(quote),
  };
  useViewEvent("business_note", tier, show, base);
  const send = usePaywallEvents("business_note", tier, base);
  if (!show || !prices) return null;
  const row = (
    name: string,
    cents: number,
    share: number | undefined,
    testId: string,
  ) => (
    <div
      data-testid={testId}
      className="flex min-h-11 items-center gap-3 rounded-[10px] border border-dashed border-edge px-3.5 py-2"
    >
      <span className="flex flex-1 flex-col">
        <span className="text-sm text-fg">{t("plans.quote.withPlan", { plan: name })}</span>
        {share ? (
          <span className="text-[11px] text-fg-muted">
            {t("plans.quote.cinema.share", { pct: Math.round(share * 100) })}
          </span>
        ) : null}
      </span>
      <span className="font-mono text-sm text-fg">{formatCents(cents, t)}</span>
    </div>
  );
  return (
    <div data-testid="cinema-tier-prices" className="flex flex-col gap-2">
      {row("Business", prices.business, pct?.business, "cinema-business")}
      {row("Studio", prices.studio, pct?.studio, "cinema-studio")}
      <div className="flex items-center gap-3 text-[11px]">
        <Link
          href="/plans"
          onClick={() => send("click", { target: "/plans" })}
          className="text-primary hover:underline"
        >
          {range
            ? t("plans.quote.cinema.seeBusinessSave", { business: "Business", range })
            : t("plans.quote.note.seeBusiness", { business: "Business" })}
        </Link>
        <button
          type="button"
          onClick={() => {
            send("dismiss");
            dismiss();
          }}
          className="ms-auto flex items-center gap-1 text-fg-muted hover:text-fg"
        >
          <X className="size-3" aria-hidden /> {t("plans.quote.hide")}
        </button>
      </div>
    </div>
  );
}
