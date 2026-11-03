"use client";

/**
 * Shared quote → convert → track machinery for the per-step panels
 * (Depth / Stereo / Deliver). Pay-as-you-go billing: there is NO checkout
 * step — the gateway verifies the saved card up front (402 otherwise) and
 * either starts the job immediately (cheap runs; card charged on success)
 * or places an off-session hold first (expensive runs; captured on
 * success). A 3DS demand on the hold comes back as billing
 * requires_action and is completed here with the saved card — the only
 * "payment UI" the user ever sees is the bank's challenge. Billing
 * behaviors preserved from the checkout era:
 *
 * - quotes come from POST /v1/projects/{id}/quotes — no client price math;
 * - a param change INVALIDATES the quote and the pending attempt;
 * - the Idempotency-Key is stable per attempt (minted lazily on the first
 *   Convert click, reused on retries) so a double-submit can't double-charge;
 * - a 402 (no_payment_method / billing_overdue / card_declined) surfaces as
 *   a billing notice with the right escape hatch instead of a raw error;
 * - onProjectChanged refetches the workspace after a successful run.
 *
 * State lives OUTSIDE the component (jotai, keyed by project+step — see
 * checkoutStore): the panels unmount on every tab switch, and an in-flight
 * run must survive that. Across a full page reload the jotai store is gone,
 * so the hook adopts the newest still-running step conversion from
 * project.conversions (the gateway persists them in Firestore) — the
 * in-progress tracker survives refreshes too.
 */

import { useAtom } from "jotai";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { PayToContinue, supportMailto } from "@/components/billing/BillingBanner";
import { ChinaPaySheet } from "@/components/pay/ChinaPaySheet";
import { PaySheet } from "@/components/pay/PaySheet";
import { chinaPayments } from "@/lib/paymentRegion";
import { useBalanceDialogs } from "@/components/pay/BalanceDialogs";
import {
  PAID_FROM_BALANCE,
  PAUSED_REVIEW,
  paidFromBalanceReload,
  POP_AFTER,
  POP_PRECHARGE,
  POP_SHEET,
  popBalance,
  SPEND_LIMIT_REACHED,
} from "@/components/pay/payCopy";
import { completeChargeAction } from "@/components/billing/settleAction";
import { Button } from "@/components/ui/button";
import { InfoPopover } from "@/components/ui/info-popover";
import { track, upgradeSession } from "@/lib/analytics";
import { GatewayError } from "@/lib/api/client";
import {
  conversionMethod,
  methodOf,
  type Conversion,
  type Project,
  type Step,
  type StepConversionRequest,
  type StepQuoteResponse,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";
import { outstandingCents } from "@/lib/billingCopy";

import { stepCheckoutAtom } from "./checkoutStore";
import { ConversionTracker, runLine, TERMINAL_STATES } from "./ConversionTracker";
import { methodErrorCopy } from "./methods";
import { formatCents } from "./money";
import { CHARGE_AFTER_COPY, CHARGE_BEFORE_COPY, QuoteView } from "./QuoteView";

function messageOf(e: unknown): string {
  // spec v7 N12: a run that would pass the monthly spend limit
  if (e instanceof GatewayError && e.code === "spend_limit_reached") return SPEND_LIMIT_REACHED;
  const friendly = e instanceof GatewayError ? methodErrorCopy(e.code) : null;
  if (friendly !== null) return friendly;
  return e instanceof Error ? e.message : "request failed";
}

/** 402 gate codes the panels route on (lib/api/types.ts APIErrorBody). */
export type BillingBlock =
  | "no_payment_method"
  | "billing_overdue"
  | "card_declined";

function billingBlockOf(e: unknown): BillingBlock | null {
  if (e instanceof GatewayError) {
    if (e.code === "no_payment_method" || e.code === "card_declined") {
      return e.code;
    }
    // S3D-22: a payment needs a new card (billing_overdue on older
    // gateways)
    if (e.code === "billing_overdue" || e.code === "payment_method_needed") {
      return "billing_overdue";
    }
  }
  return null;
}

export interface StepCheckout {
  quote: StepQuoteResponse | null;
  quoting: boolean;
  error: string | null;
  /** conversion creation was blocked by the billing gate (402) */
  billingBlock: BillingBlock | null;
  active: Conversion | null;
  /** created and being tracked, not yet terminal */
  running: boolean;
  /** the conversion's tracker should stay mounted (incl. after settle) */
  tracking: boolean;
  settled: boolean;
  /** Priced inputs changed — quote (and any pending attempt) is stale. */
  invalidate: () => void;
  /** keepTracker: an automatic re-quote leaves a finished run's tracker */
  fetchQuote: (
    req: StepConversionRequest,
    opts?: { keepTracker?: boolean },
  ) => Promise<void>;
  convert: (req: StepConversionRequest) => Promise<void>;
  handleSettled: (settled: Conversion) => void;
  /** Tracker poll snapshots — keeps the shared store current so a remount
   * mid-run resumes from the latest progress, not the creation response. */
  handleUpdate: (conversion: Conversion) => void;
  onProjectChanged: () => void;
  /** a run waiting for its payment: the pay sheet is open (P1/P3) */
  payNow: Conversion | null;
  /** the sheet closed: paid, or left open (the run waits, P12) */
  closePayNow: (paid: boolean) => void;
  /** P12 Finish payment: reopen the waiting run's sheet */
  reopenPayNow: () => void;
}

export function useStepCheckout(
  project: Project,
  step: Step,
  onProjectChanged: () => void,
): StepCheckout {
  const client = useGateway();
  const billing = useBilling();

  // Survives tab navigation (module-scoped jotai store, see checkoutStore).
  const method = methodOf(project);
  const [state, setState] = useAtom(
    stepCheckoutAtom(project.project_id, step, method),
  );
  const { quote, attemptKey, active, settled } = state;
  // Transient request feedback — a remount clearing these is fine.
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billingBlock, setBillingBlock] = useState<BillingBlock | null>(null);
  const [payNow, setPayNow] = useState<Conversion | null>(null);
  // Idempotency-Key, stable per attempt: minted lazily on the first Convert
  // click and reused on retries so a double-submit can't double-charge. The
  // ref mirrors the stored key for SYNCHRONOUS dedup (two clicks in the same
  // render must mint one key); the store carries it across remounts. Every
  // writer below updates BOTH; the effect only covers external store writes.
  const attemptKeyRef = useRef(attemptKey);
  useEffect(() => {
    attemptKeyRef.current = attemptKey;
  }, [attemptKey]);

  // Refresh survival: the jotai store dies with the page, but the gateway
  // persists conversions in Firestore and returns them with the project —
  // adopt the newest still-running step conversion so a reload shows the
  // in-progress tracker instead of a fresh Convert UI.
  const conversions = project.conversions;
  useEffect(() => {
    if (active !== null) return;
    const running = (conversions ?? [])
      .filter(
        (c) =>
          c.step === step &&
          conversionMethod(c) === method &&
          !TERMINAL_STATES.has(c.state),
      )
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    if (running !== undefined) {
      setState((s) =>
        s.active !== null ? s : { ...s, active: running, settled: false },
      );
    }
  }, [active, conversions, method, step, setState]);

  // Stable (setState from useAtom is): panels call this from effects that
  // watch priced inputs (e.g. the Depth page's passthrough set).
  const invalidate = useCallback((): void => {
    attemptKeyRef.current = null;
    setState((s) => ({ ...s, quote: null, attemptKey: null }));
  }, [setState]);

  async function fetchQuote(
    req: StepConversionRequest,
    opts: { keepTracker?: boolean } = {},
  ): Promise<void> {
    setQuoting(true);
    setError(null);
    setBillingBlock(null);
    try {
      const res = await client.quoteStep(project.project_id, req);
      track("quote_received", {
        step,
        value: res.quote.amount_cents / 100,
        currency: "USD",
      });
      attemptKeyRef.current = null; // fresh quote = fresh attempt
      setState((s) => ({
        ...s,
        quote: res,
        attemptKey: null,
        // clear a finished run's tracker before a new attempt
        ...(s.settled && !opts.keepTracker ? { active: null, settled: false } : {}),
      }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setQuoting(false);
    }
  }

  async function convert(req: StepConversionRequest): Promise<void> {
    if (attemptKeyRef.current === null) {
      attemptKeyRef.current = crypto.randomUUID();
      const minted = attemptKeyRef.current;
      setState((s) => ({ ...s, attemptKey: minted }));
    }
    setError(null);
    setBillingBlock(null);
    try {
      const conv = await client.createStepConversion(
        project.project_id,
        req,
        attemptKeyRef.current,
      );
      track("conversion_started", {
        step,
        ...(quote !== null
          ? { value: quote.quote.amount_cents / 100, currency: "USD" }
          : {}),
      });
      upgradeSession("paid-conversion");
      setState((s) => ({ ...s, active: conv, settled: false }));
      // spec v7 N5: a hold on the balance (maybe after an auto-reload)
      if (conv.billing?.status === "balance_hold") void billing.refresh();
      // a pay-now method: the run waits for this payment (S3D-60/61)
      if (conv.billing?.status === "requires_payment") setPayNow(conv);
      // Expensive runs hold the quote up front; a 3DS demand on that hold
      // arrives as requires_action — complete it with the saved card. The
      // gateway webhook then flips created→paid and starts the job (the
      // tracker is already polling).
      if (
        conv.billing?.status === "requires_action" &&
        conv.billing.client_secret &&
        conv.billing.publishable_key
      ) {
        const done = await completeChargeAction(
          conv.billing.publishable_key,
          conv.billing.client_secret,
        );
        if (!done.ok) {
          setError(
            done.error ??
              "Payment confirmation failed — the conversion was not started.",
          );
          void client.cancelConversion(conv.conversion_id).catch(() => {});
          attemptKeyRef.current = null; // fresh attempt after a failed confirm
          setState((s) => ({ ...s, active: null, attemptKey: null }));
        }
      }
    } catch (e) {
      const block = billingBlockOf(e);
      if (block !== null) {
        track("billing_blocked", { step, code: block });
        setBillingBlock(block);
        // an overdue charge appeared since the last fetch — resync the
        // banner/status so the settle UI shows up
        void billing.refresh();
      } else {
        setError(messageOf(e));
      }
    }
  }

  function handleSettled(settledConv: Conversion): void {
    if (settledConv.state === "succeeded") {
      // The card is charged on success — this is the purchase moment.
      track("purchase", {
        transaction_id: settledConv.conversion_id,
        step,
        ...(quote !== null
          ? { value: quote.quote.amount_cents / 100, currency: "USD" }
          : {}),
      });
    } else {
      track("conversion_failed", { step, state: settledConv.state });
    }
    attemptKeyRef.current = null;
    setState((s) => ({
      ...s,
      settled: true,
      attemptKey: null,
      // run complete — drop the spent quote
      ...(settledConv.state === "succeeded" ? { quote: null } : {}),
    }));
    if (
      settledConv.state === "succeeded" &&
      settledConv.billing &&
      settledConv.billing.status !== "charged"
    ) {
      // (also a balance run: the hold became the final cost)
      // The automatic charge (or its failure) is now on the conversion —
      // refresh so a charge_failed surfaces in the billing banner.
      void billing.refresh();
    }
  }

  // Stable (setState from useAtom is): the tracker's poll effect lists it
  // as a dependency and must not restart its interval every render.
  const handleUpdate = useCallback(
    (conv: Conversion): void => {
      setState((s) =>
        s.active !== null && s.active.conversion_id === conv.conversion_id
          ? { ...s, active: conv }
          : s,
      );
    },
    [setState],
  );

  // spec v6 G2: closing a sheet with the payment open needs no
  // confirmation and cancels nothing — the run shows "Waiting for
  // payment…" with Finish payment (P12)
  function closePayNow(paid: boolean): void {
    setPayNow(null);
    if (paid) void billing.refresh(); // the method used is saved now
  }

  function reopenPayNow(): void {
    if (active !== null && active.state === "created") setPayNow(active);
  }

  const tracking = active !== null;
  const running = tracking && !settled;

  return {
    quote,
    quoting,
    error,
    billingBlock,
    active,
    running,
    tracking,
    settled,
    invalidate,
    fetchQuote,
    convert,
    handleSettled,
    handleUpdate,
    onProjectChanged,
    payNow,
    closePayNow,
    reopenPayNow,
  };
}

/** P1/P3 for the checkout's waiting run; China mode: P6 (no Stripe.js). */
function PaySheetFor({ ck, action }: { ck: StepCheckout; action: string }): JSX.Element | null {
  const conv = ck.payNow;
  if (conv === null) return null;
  if (chinaPayments()) {
    return (
      <ChinaPaySheet
        conversionId={conv.conversion_id}
        projectId={conv.project_id}
        amountCents={conv.quote.amount_cents}
        subtitle={runLine(conv)}
        onClose={(paid) => ck.closePayNow(paid)}
      />
    );
  }
  return (
    <PaySheet
      conversionId={conv.conversion_id}
      amountCents={conv.quote.amount_cents}
      action={action}
      subtitle={runLine(conv)}
      billing={conv.billing}
      projectId={conv.project_id}
      onClose={(outcome) => ck.closePayNow(outcome === "paid")}
    />
  );
}

/** P14: the charge line under the run button, from how it'd be paid. */
function chargeLineFor(quote: StepQuoteResponse): string {
  if (quote.spend_limit_reached) return SPEND_LIMIT_REACHED;
  if (quote.payment_flow === "balance") {
    return quote.balance?.reload_cents ? paidFromBalanceReload(quote.balance.reload_cents) : PAID_FROM_BALANCE;
  }
  if (quote.payment_flow === "after") return CHARGE_AFTER_COPY;
  if (quote.payment_flow === "precharge" || quote.payment_flow === "paynow") {
    return CHARGE_BEFORE_COPY;
  }
  return quote.charge_timing === "before" ? CHARGE_BEFORE_COPY : CHARGE_AFTER_COPY;
}

/** P14: the "?" pop-over, per account state; null = the panel's own. */
function popoverFor(quote: StepQuoteResponse | null): string | null {
  if (quote?.spend_limit_reached) return null;
  switch (quote?.payment_flow) {
    case "balance":
      return popBalance(quote.quote.amount_cents);
    case "after":
      return POP_AFTER;
    case "precharge":
      return POP_PRECHARGE;
    case "paynow":
      return POP_SHEET;
    default:
      return null;
  }
}

/** P14 "Balance short, auto-reload off": "Balance $3.20 · Add funds". */
function BalanceShort({ quote }: { quote: StepQuoteResponse | null }): JSX.Element | null {
  const { openAddFunds } = useBalanceDialogs();
  const b = quote?.balance;
  if (!quote || !b || quote.payment_flow === "balance" || quote.spend_limit_reached) return null;
  return (
    <span data-testid="balance-short" className="text-xs text-fg-muted tabular-nums">
      Balance {formatCents(b.available_cents)} ·{" "}
      <button type="button" className="font-medium text-primary hover:underline" onClick={openAddFunds}>
        Add funds
      </button>
    </span>
  );
}

/** P14 "Spend limit reached": Change limit opens P19. */
function ChangeLimit(): JSX.Element {
  const { openSpending } = useBalanceDialogs();
  return (
    <button type="button" data-testid="change-limit" className="text-xs font-medium text-primary hover:underline" onClick={openSpending}>
      Change limit
    </button>
  );
}

/** P14 "Under review": paused, with Contact support. */
function UnderReview(): JSX.Element {
  return (
    <div data-testid="under-review" className="flex flex-col items-center gap-1.5 text-sm">
      <span className="text-fg-muted">{PAUSED_REVIEW}</span>
      <a href={supportMailto()} className="text-primary hover:underline">
        Contact support
      </a>
    </div>
  );
}

/** The 402 notice with the right escape hatch: onboarding for a missing
 * card, the billing banner's settle flow for an overdue charge, the account
 * page for a declined hold. */
function BillingBlockNotice({ block }: { block: BillingBlock }): JSX.Element {
  if (block === "no_payment_method") {
    return (
      <div
        data-testid="billing-block"
        className="rounded-lg border border-edge bg-surface-2 p-3 text-sm"
      >
        <p className="text-fg">
          A payment method is needed before starting paid conversions.
        </p>
        <Link
          href="/account/billing"
          className="mt-1 inline-block text-primary hover:underline"
        >
          Add payment method →
        </Link>
      </div>
    );
  }
  if (block === "card_declined") {
    return (
      <div
        data-testid="billing-block"
        className="rounded-lg border border-red-900/60 bg-red-950/40 p-3 text-sm"
      >
        <p className="text-red-200">
          The payment for this run was declined. Nothing was charged.
        </p>
        <Link
          href="/account/billing"
          className="mt-1 inline-block text-primary hover:underline"
        >
          Update payment method →
        </Link>
      </div>
    );
  }
  return <PayToContinue />;
}

export interface StepCheckoutSectionProps {
  checkout: StepCheckout;
  /** The request the panel's CURRENT params produce — used for both the
   * quote and the conversion, so what was quoted is what runs. */
  request: StepConversionRequest;
  /** Show the tracker's downloads list on success (default). Depth passes
   * false — its inline depth view + Export button surface the outputs. */
  trackerDownloads?: boolean;
  /** When set, the panel's params are not runnable (e.g. every format
   * deselected): Get quote / Convert are disabled and this reason renders
   * beside them. */
  disabledReason?: string;
}

/** The uniform bottom half of every step panel: Get quote / Convert buttons,
 * error line, quote line items, and the conversion tracker. */
export function StepCheckoutSection({
  checkout: ck,
  request,
  trackerDownloads = true,
  disabledReason,
}: StepCheckoutSectionProps): JSX.Element {
  const blocked = disabledReason !== undefined;
  // S3D-22: while a payment needs a new card, paid actions say so instead
  // of offering their button
  const paymentNeeded =
    outstandingCents(useBilling().status) > 0 ||
    ck.billingBlock === "billing_overdue";
  if (paymentNeeded && !ck.tracking) return <PayToContinue size="default" />;
  return (
    <>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          onClick={() => void ck.fetchQuote(request)}
          disabled={ck.quoting || blocked}
        >
          Get quote
        </Button>
        {ck.quote && !ck.running && !blocked ? (
          <Button onClick={() => void ck.convert(request)}>
            Convert · {formatCents(ck.quote.quote.amount_cents)}
          </Button>
        ) : null}
        {ck.quote && !ck.running && !blocked ? (
          <span data-testid="charge-timing-hint" className="text-xs text-fg-muted">
            {ck.quote.charge_timing === "before"
              ? CHARGE_BEFORE_COPY
              : CHARGE_AFTER_COPY}
          </span>
        ) : null}
        {blocked ? (
          <span className="text-xs text-amber-400">{disabledReason}</span>
        ) : null}
      </div>
      {ck.error ? <p className="text-sm text-red-400">{ck.error}</p> : null}
      {ck.billingBlock ? <BillingBlockNotice block={ck.billingBlock} /> : null}
      {ck.quote ? (
        <QuoteView result={ck.quote} />
      ) : null}
      {ck.tracking && ck.active ? (
        <ConversionTracker
          conversion={ck.active}
          onProjectChanged={ck.onProjectChanged}
          onSettled={ck.handleSettled}
          onUpdate={ck.handleUpdate}
          showDownloads={trackerDownloads}
          estimateSeconds={ck.quote?.eta_seconds}
          onFinishPayment={ck.reopenPayNow}
        />
      ) : null}
      <PaySheetFor ck={ck} action="Convert" />
    </>
  );
}

export interface InstantCheckoutProps {
  checkout: StepCheckout;
  request: StepConversionRequest;
  /** What prices the run when it differs from `request` only in ways that
   * can't change the price (the Preview page's start moment, so scrubbing
   * doesn't re-price). Defaults to `request`. */
  quoteRequest?: StepConversionRequest;
  /** The main button's words: "Preview this moment", "Make 3D". */
  label: string;
  disabledReason?: string;
  /** Extra lines for the "?" popover (how this run is priced). */
  explain?: ReactNode;
  /** Show the tracker's downloads list on success (default). */
  trackerDownloads?: boolean;
  /** Under the button, e.g. "Make the whole video in 3D" */
  after?: ReactNode;
  /** "panel": the price card of a Make 3D page — the quote's lines in
   * full, the charging line with "?", then a full-width button. */
  variant?: "inline" | "panel";
  /** The price card's heading row ("Your price" + method chip). */
  heading?: ReactNode;
}

/**
 * One main button with its price (S3D-45): the run is priced as the
 * settings change (no "Get quote" step), the button starts it, and the
 * details — the quote's lines, the minimum, when it's charged — sit behind
 * the "?" beside the one charging line. P14: while the account owes the
 * button reads "Pay $X to continue" (the settle sheet); under review it is
 * paused with Contact support; a run that waits for its payment opens the
 * pay sheet (P1/P3).
 */
export function InstantCheckout({
  checkout: ck,
  request,
  quoteRequest,
  label,
  disabledReason,
  explain,
  trackerDownloads = true,
  after,
  variant = "inline",
  heading,
}: InstantCheckoutProps): JSX.Element {
  const status = useBilling().status;
  const underReview = status?.flow_state === "under_review";
  const stopQuoting = disabledReason !== undefined || underReview;
  const limitReached = ck.quote?.spend_limit_reached === true || ck.error === SPEND_LIMIT_REACHED;
  const blocked = disabledReason !== undefined || underReview || limitReached;
  const paymentNeeded =
    outstandingCents(status) > 0 || ck.billingBlock === "billing_overdue";
  const key = JSON.stringify(quoteRequest ?? request);
  const lastKey = useRef<string | null>(null);
  const { quote, quoting, running, error, fetchQuote } = ck;
  useEffect(() => {
    if (stopQuoting || running || quoting || quote !== null) return;
    // a failed quote waits for a change instead of retrying in a loop
    if (key === lastKey.current && error !== null) return;
    const t = setTimeout(() => {
      lastKey.current = key;
      void fetchQuote(JSON.parse(key) as StepConversionRequest, {
        keepTracker: true,
      });
    }, 250);
    return () => clearTimeout(t);
    // fetchQuote is a fresh closure each render; key carries the request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stopQuoting, running, quoting, quote, error]);

  const price = quote ? formatCents(quote.quote.amount_cents) : null;
  const sheet = <PaySheetFor ck={ck} action={label} />;
  const chargeText = quote ? chargeLineFor(quote) : CHARGE_AFTER_COPY;
  // P14: the pop-over says how this account pays; the panel's own when the
  // gateway doesn't say
  const popover = popoverFor(quote) ?? explain;
  const tracker =
    ck.tracking && ck.active ? (
      <ConversionTracker
        conversion={ck.active}
        onProjectChanged={ck.onProjectChanged}
        onSettled={ck.handleSettled}
        onUpdate={ck.handleUpdate}
        showDownloads={trackerDownloads}
        estimateSeconds={quote?.eta_seconds}
        onFinishPayment={ck.reopenPayNow}
      />
    ) : null;
  const owes = paymentNeeded && !ck.tracking;
  if (variant === "panel") {
    const chargeHint = quote && !owes && !underReview ? (
      <span className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5">
          <span data-testid="charge-timing-hint" className={`text-xs ${limitReached ? "text-amber-300" : "text-fg"}`}>
            {chargeText}
          </span>
          {popover && !limitReached ? <InfoPopover label="?" align="right">{popover}</InfoPopover> : null}
          {limitReached ? <ChangeLimit /> : null}
        </span>
        <BalanceShort quote={quote} />
      </span>
    ) : null;
    return (
      <div className="flex flex-col gap-3">
        <section
          data-testid="price-card"
          className="flex flex-col gap-4 rounded-xl border border-edge bg-surface-1 p-5"
        >
          {heading}
          {quote ? (
            <QuoteView result={quote} chargeLine={false} bare />
          ) : (
            <p className="text-sm text-fg-muted">
              {stopQuoting ? disabledReason : quoting ? "Pricing…" : error ?? "Pricing…"}
            </p>
          )}
          {chargeHint}
          {owes ? (
            <PayToContinue />
          ) : (
            <Button
              size="lg"
              data-testid="checkout-main"
              className="w-full"
              disabled={blocked || quote === null || running}
              onClick={() => void ck.convert(request)}
            >
              {label}
              {price ? ` · ${price}` : ""}
            </Button>
          )}
          {underReview && !owes ? <UnderReview /> : null}
          {after}
          {error && quote && error !== chargeText ? <p className="text-sm text-red-400">{error}</p> : null}
          {ck.billingBlock ? <BillingBlockNotice block={ck.billingBlock} /> : null}
        </section>
        {tracker}
        {sheet}
        {/* phone (screen 11): the one button stays in reach at the bottom */}
        {owes ? (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-edge bg-surface-1/95 p-3 backdrop-blur lg:hidden">
            <PayToContinue />
          </div>
        ) : !running ? (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-edge bg-surface-1/95 p-3 backdrop-blur lg:hidden">
            <Button
              size="lg"
              data-testid="checkout-main-phone"
              className="w-full"
              disabled={blocked || quote === null}
              onClick={() => void ck.convert(request)}
            >
              {label}
              {price ? ` · ${price}` : ""}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  if (owes) {
    return (
      <div className="flex flex-col gap-3">
        <div className="w-fit">
          <PayToContinue />
        </div>
        {tracker}
        {sheet}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          size="lg"
          data-testid="checkout-main"
          disabled={blocked || quote === null || running}
          onClick={() => void ck.convert(request)}
        >
          {label}
          {price ? ` · ${price}` : ""}
        </Button>
        {underReview ? (
          <UnderReview />
        ) : limitReached ? (
          <span className="flex items-center gap-1.5">
            <span data-testid="charge-timing-hint" className="text-xs text-amber-300">
              {SPEND_LIMIT_REACHED}
            </span>
            <ChangeLimit />
          </span>
        ) : blocked ? (
          <span className="text-xs text-amber-400">{disabledReason}</span>
        ) : quote ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <span data-testid="charge-timing-hint" className="text-xs text-fg-muted">
              {chargeText}
            </span>
            <InfoPopover label="?">
              {popoverFor(quote) ? <p>{popoverFor(quote)}</p> : null}
              {explain}
              <QuoteView result={quote} />
            </InfoPopover>
            <BalanceShort quote={quote} />
          </span>
        ) : quoting ? (
          <span className="text-xs text-fg-muted">Pricing…</span>
        ) : null}
      </div>
      {after}
      {error && !limitReached ? <p className="text-sm text-red-400">{error}</p> : null}
      {ck.billingBlock ? <BillingBlockNotice block={ck.billingBlock} /> : null}
      {tracker}
      {sheet}
    </div>
  );
}
