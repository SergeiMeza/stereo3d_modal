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

import { useAtom, useAtomValue, useSetAtom, type PrimitiveAtom } from "jotai";
import Link from "next/link";
import { useCallback, useEffect, useRef } from "react";
import type { JSX, ReactNode } from "react";

import { PayToContinue, supportMailto } from "@/components/billing/BillingBanner";
import { ChinaPaySheet } from "@/components/pay/ChinaPaySheet";
import {
  CHINA_COMING_SOON_KEY,
  ChinaComingSoonSheet,
  isChinaPaymentsUnavailable,
  useChinaPaymentsOff,
} from "@/components/pay/chinaComingSoon";
import { PaySheet } from "@/components/pay/PaySheet";
import { chinaPayments } from "@/lib/paymentRegion";
import { useBalanceDialogs } from "@/components/pay/BalanceDialogs";
import { paidFromBalanceReload, popBalance } from "@/components/pay/payCopy";
import { completeChargeAction } from "@/components/billing/settleAction";
import { OneTapBlock } from "@/components/pay/OneTapBlock";
import { handleOneTapAction, oneTapLabel, oneTapRefusal } from "@/components/pay/oneTap";
import { Button } from "@/components/ui/button";
import { InfoPopover } from "@/components/ui/info-popover";
import { track, upgradeSession } from "@/lib/analytics";
import { mockOpen } from "@/lib/mockOpen";
import { GatewayError } from "@/lib/api/client";
import {
  conversionMethod,
  methodOf,
  type Conversion,
  type OneTapOffer,
  type Project,
  tapStateOf,
  type Step,
  type StepConversionRequest,
  type StepQuoteResponse,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";
import { outstandingCents } from "@/lib/billingCopy";
import { useT } from "@/lib/i18n/I18nProvider";
import { rich } from "@/lib/i18n/rich";
import { EN, type Tr } from "@/lib/i18n/t";
import { commercialRunWords } from "@/lib/commercial";
import { stabilizeRunWords } from "@/lib/stabilize";

import { stepCheckoutAtom, type BillingBlock, type OneTapRun, type StepCheckoutState } from "./checkoutStore";
import { invalidateQuoteAtom, QUOTE_TIMED_OUT, quoteView, requestQuoteAtom, useAutoQuote } from "./quoteAtoms";
import { ConversionTracker, runLine, TERMINAL_STATES } from "./ConversionTracker";
import { PinnedRun } from "./RunProgressCompact";
import { applyRun } from "@/lib/live/liveStore";
import { useLiveRunOrNull } from "@/lib/live/useLive";
import { appStore } from "@/lib/state/stores";
import { methodErrorCopy } from "./methods";
import { formatCents, formatUsdLabeled } from "./money";
import { fpsPlanRequired, pickFrameRate } from "./frameRate";
import { chargeAfterCopy, chargeBeforeCopy, QuoteView, runFacts } from "./QuoteView";
import { formatsText } from "@/lib/glossary";

function messageOf(e: unknown, t: Tr = EN): string {
  // owner 2026-11-07: a paid China run while China payments are off
  if (isChinaPaymentsUnavailable(e)) return t(CHINA_COMING_SOON_KEY);
  // spec v7 N12: a run that would pass the monthly spend limit
  if (e instanceof GatewayError && e.code === "spend_limit_reached") return t("balance.copy.spendLimitReached");
  if (e instanceof GatewayError && e.code === "payment_method_blocked") return t("balance.copy.paymentMethodBlocked");
  if (e instanceof GatewayError && e.code === "deletion_pending") return t("balance.copy.deletionPending");
  // owner 2026-11-04: an explicit target_fps above the account's max_fps
  if (e instanceof GatewayError && e.code === "plan_required_fps") return fpsPlanRequired(t);
  // a web run on a source above 30 fps without a rate (the page asks first)
  if (e instanceof GatewayError && e.code === "fps_choice_required") return pickFrameRate(t);
  const friendly = e instanceof GatewayError ? methodErrorCopy(e.code, t) : null;
  if (friendly !== null) return friendly;
  if (e instanceof Error && e.message === QUOTE_TIMED_OUT) return t("quote.timedOut");
  return e instanceof Error ? e.message : t("make.checkout.requestFailed");
}

export type { BillingBlock } from "./checkoutStore";

/** The run button while its run is being created. */
export const STARTING = EN("make.checkout.starting");

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

export { QUOTE_TIMED_OUT, QUOTE_TIMEOUT_MS } from "./quoteAtoms";

export interface StepCheckout {
  /** a run is being created (the button is busy) */
  converting: boolean;
  /** ADR 0138: the checkout atom every reader of this panel shares */
  scope: PrimitiveAtom<StepCheckoutState>;
  quote: StepQuoteResponse | null;
  /** the request `quote` answers (JSON); undefined when not known */
  quoteKey?: string;
  /** the last quote received, also while a change re-prices */
  lastQuote: StepQuoteResponse | null;
  quoting: boolean;
  /** the request being priced now (JSON), null when none */
  pendingKey: string | null;
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
  /** BUX-20: where a one-tap payment stands (null: none going) */
  oneTap: OneTapRun | null;
  /** BUX-20: pay the run with one tap on the saved default (creates it
   * first); the amount is the one the button shows */
  payOneTap: (req: StepConversionRequest) => Promise<void>;
  /** BUX-20: the sheet instead (the run's, or a new run's) */
  payAnotherWay: (req: StepConversionRequest) => Promise<void>;
}

export function useStepCheckout(
  project: Project,
  step: Step,
  onProjectChanged: () => void,
): StepCheckout {
  const client = useGateway();
  const billing = useBilling();
  const t = useT();

  // Survives tab navigation (module-scoped jotai store, see checkoutStore).
  const method = methodOf(project);
  const [state, setState] = useAtom(
    stepCheckoutAtom(project.project_id, step, method),
  );
  const { attemptKey, active: stored, settled } = state;
  // owner 2026-11-07: the run as the live feed knows it, whichever tab
  // shows it (the tracker may not be mounted)
  const active = useLiveRunOrNull(stored);
  // ADR 0138: the price, its request and errors live in the checkout atom
  // (quoteAtoms writes them), so every reader agrees
  const view = quoteView(state);
  const quote = view.quote;
  const quoting = view.quoting;
  const pendingKey = state.pendingKey ?? null;
  const error = state.error ?? view.error;
  const billingBlock = state.billingBlock ?? null;
  const payNow = state.payNow ?? null;
  const setError = (e: string | null): void => setState((s) => ({ ...s, error: e }));
  const setBillingBlock = (b: BillingBlock | null): void => setState((s) => ({ ...s, billingBlock: b }));
  const setPayNow = (c: Conversion | null): void => setState((s) => ({ ...s, payNow: c }));
  const oneTap = state.oneTap ?? null;
  const setOneTap = (o: OneTapRun | null): void => setState((s) => ({ ...s, oneTap: o }));
  const requestQuote = useSetAtom(requestQuoteAtom);
  const invalidateQuote = useSetAtom(invalidateQuoteAtom);
  const scope = stepCheckoutAtom(project.project_id, step, method);
  // Idempotency-Key, stable per attempt: minted lazily on the first Convert
  // click and reused on retries so a double-submit can't double-charge. The
  // ref mirrors the stored key for SYNCHRONOUS dedup (two clicks in the same
  // render must mint one key); the store carries it across remounts. Every
  // writer below updates BOTH; the effect only covers external store writes.
  const attemptKeyRef = useRef(attemptKey);
  const convertingRef = useRef(false);
  // BUX-20: one tap at a time (a double click never pays twice)
  const tappingRef = useRef(false);
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
      // the mock's screenshot deep link (?mockOpen=pay): the waiting run's
      // pay sheet opens at once
      const pay = running.state === "created" && mockOpen() === "pay";
      setState((s) =>
        s.active !== null ? s : { ...s, active: running, settled: false, ...(pay ? { payNow: running } : {}) },
      );
    }
  }, [active, conversions, method, step, setState]);

  // Stable: panels call this from effects that watch priced inputs (e.g.
  // the Depth page's passthrough set).
  const invalidate = useCallback((): void => {
    attemptKeyRef.current = null;
    invalidateQuote(scope);
  }, [invalidateQuote, scope]);

  async function fetchQuote(
    req: StepConversionRequest,
    opts: { keepTracker?: boolean } = {},
  ): Promise<void> {
    await requestQuote({
      scope,
      client,
      projectId: project.project_id,
      req,
      keepTracker: opts.keepTracker,
      describe: (e) => messageOf(e, t),
    });
  }

  async function convert(req: StepConversionRequest): Promise<void> {
    await create(req, "sheet");
  }

  /** Creates the run; "oneTap": a run waiting for its payment is paid by
   * the caller instead of opening the sheet. Answers the new run. */
  async function create(req: StepConversionRequest, mode: "sheet" | "oneTap"): Promise<Conversion | null> {
    // QA 2026-11-05 batch 2: one create at a time (a double click or a slow
    // answer never starts two runs); the button shows it's starting
    if (convertingRef.current) return null;
    convertingRef.current = true;
    setState((s) => ({ ...s, converting: true }));
    try {
      return await convertOnce(req, mode);
    } finally {
      convertingRef.current = false;
      setState((s) => ({ ...s, converting: false }));
    }
  }

  async function convertOnce(req: StepConversionRequest, mode: "sheet" | "oneTap"): Promise<Conversion | null> {
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
      // the new run joins the live feed at once (every surface shows it)
      applyRun(appStore, conv);
      setState((s) => ({ ...s, active: conv, settled: false }));
      // the new run shows in the lists (Past previews, Files) and the
      // free previews left are priced again
      onProjectChanged();
      invalidate();
      // spec v7 N5: a hold on the balance (maybe after an auto-reload)
      if (conv.billing?.status === "balance_hold") void billing.refresh();
      // a pay-now method: the run waits for this payment (S3D-60/61);
      // BUX-20: a one-tap pays it without the sheet when the run allows
      if (conv.billing?.status === "requires_payment" && (mode === "sheet" || !conv.one_tap)) setPayNow(conv);
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
            done.error ?? t("make.checkout.confirmFailed"),
          );
          void client.cancelConversion(conv.conversion_id).catch(() => {});
          attemptKeyRef.current = null; // fresh attempt after a failed confirm
          setState((s) => ({ ...s, active: null, attemptKey: null }));
        }
      }
      return conv;
    } catch (e) {
      const block = billingBlockOf(e);
      if (block !== null) {
        track("billing_blocked", { step, code: block });
        setBillingBlock(block);
        // an overdue charge appeared since the last fetch — resync the
        // banner/status so the settle UI shows up
        void billing.refresh();
      } else {
        setError(messageOf(e, t));
      }
      return null;
    }
  }

  /** The run as the gateway has it now (the tap's answer carries the
   * tap's state over the run's). */
  function refreshRun(id: string): void {
    client.getConversion(id).then(
      (c) => {
        applyRun(appStore, c);
        setState((s) => (s.active?.conversion_id === c.conversion_id ? { ...s, active: c } : s));
      },
      () => undefined,
    );
  }

  /** BUX-20: the run's sheet, the one-tap set aside. */
  function sheetFor(id: string): void {
    setOneTap(null);
    const run = active?.conversion_id === id ? active : state.payNow?.conversion_id === id ? state.payNow : null;
    if (run) return setPayNow(run);
    // the run read back goes into the checkout atom (setPayNow)
    client.getConversion(id).then(
      (c) => {
        setPayNow(c);
      },
      () => undefined,
    );
  }

  async function payOneTap(req: StepConversionRequest): Promise<void> {
    if (tappingRef.current || convertingRef.current) return;
    const going = oneTap;
    if (going && (going.phase === "paying" || going.phase === "processing" || going.phase === "in_progress")) return;
    const offer = going?.offer ?? quote?.one_tap ?? null;
    if (offer === null) return;
    const amount = going?.amountCents ?? offer.amount_cents;
    tappingRef.current = true;
    try {
      let id = going?.conversionId ?? null;
      setOneTap({ phase: "paying", conversionId: id, amountCents: amount, offer });
      if (id === null) {
        const conv = await create(req, "oneTap");
        // not created (the error shows), or paid another way already
        if (conv === null || conv.billing?.status !== "requires_payment") return setOneTap(null);
        // the offer went away meanwhile: the sheet is open for it
        if (!conv.one_tap) return setOneTap(null);
        id = conv.conversion_id;
        setOneTap({ phase: "paying", conversionId: id, amountCents: amount, offer });
      }
      await tapRun(id, amount, offer);
    } finally {
      tappingRef.current = false;
    }
  }

  async function tapRun(id: string, amount: number, offer: OneTapOffer): Promise<void> {
    const at = { conversionId: id, amountCents: amount, offer };
    let answer: Awaited<ReturnType<typeof client.payRunOneTap>>;
    try {
      answer = await client.payRunOneTap(id, amount);
    } catch (e) {
      const r = oneTapRefusal(e);
      switch (r.kind) {
        case "unavailable":
          return sheetFor(id);
        case "amount_changed":
          // never charged on its own: the new amount waits for a fresh tap
          return setOneTap({ phase: "changed", conversionId: id, amountCents: r.amountCents, offer });
        case "in_progress":
          refreshRun(id);
          return setOneTap({ phase: "in_progress", ...at });
        case "already_paid":
          setOneTap(null);
          return refreshRun(id);
        case "stale":
          setOneTap(null);
          invalidate();
          return refreshRun(id);
        default:
          return setOneTap({ phase: "declined", ...at, message: t("pay.oneTap.failed") });
      }
    }
    const tapped = tapStateOf(answer);
    let outcome: "succeeded" | "processing" | "declined" = tapped === "requires_action" ? "declined" : tapped;
    let message = answer.message;
    if (tapped === "requires_action" && answer.client_secret) {
      const done = await handleOneTapAction(answer.publishable_key ?? active?.publishable_key, answer.client_secret);
      outcome = done.status === "failed" ? "declined" : done.status;
      if (done.status === "failed") message = done.message ?? t("pay.oneTap.bankFailed");
    }
    if (outcome === "succeeded") {
      setOneTap(null);
      void billing.refresh();
      return refreshRun(id);
    }
    if (outcome === "processing") {
      setOneTap({ phase: "processing", ...at });
      return refreshRun(id);
    }
    setOneTap({ phase: "declined", ...at, message: message ?? t("pay.copy.declined") });
  }

  async function payAnotherWay(req: StepConversionRequest): Promise<void> {
    const id = oneTap?.conversionId ?? null;
    if (id !== null) return sheetFor(id);
    setOneTap(null);
    await convert(req);
  }

  // a payment being confirmed ends when the run moves on (the live feed)
  const oneTapRunId = oneTap?.conversionId ?? null;
  const oneTapPhase = oneTap?.phase;
  const activeId = active?.conversion_id;
  const activeState = active?.state;
  useEffect(() => {
    if (oneTapRunId === null || activeId !== oneTapRunId || activeState === undefined || activeState === "created") return;
    if (oneTapPhase === "processing" || oneTapPhase === "in_progress" || oneTapPhase === "changed" || oneTapPhase === "declined") {
      setState((s) => ({ ...s, oneTap: null }));
    }
  }, [oneTapRunId, oneTapPhase, activeId, activeState, setState]);

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
    // QA 2026-11-07: the price card kept "Charged when it starts" after
    // the run was Ready: the next run is priced again (the account's
    // payment terms, free previews and credit may have moved)
    invalidate();
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
    converting: state.converting === true,
    scope,
    quote,
    quoteKey: state.quoteKey,
    lastQuote: view.last,
    quoting,
    pendingKey,
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
    oneTap,
    payOneTap,
    payAnotherWay,
  };
}

/** BUX-20: the run's one-tap button with Change payment method and Pay
 * another way, when the quote (or a tap under way) offers it. */
function OneTapFor({
  ck,
  request,
  big = false,
}: {
  ck: StepCheckout;
  request: StepConversionRequest;
  big?: boolean;
}): JSX.Element | null {
  const t = useT();
  const going = ck.oneTap;
  const offer = going?.offer ?? ck.quote?.one_tap ?? null;
  if (!offer && !going) return null;
  const amount = going?.amountCents ?? offer?.amount_cents ?? 0;
  const label = offer ? oneTapLabel(offer, t, amount) : t("pay.copy.paying");
  const busy = ck.converting || going?.phase === "paying";
  const waiting = going?.phase === "processing" || going?.phase === "in_progress";
  const notice =
    going?.phase === "processing"
      ? t("pay.copy.confirming")
      : going?.phase === "in_progress"
        ? t("pay.oneTap.inProgress")
        : going?.phase === "changed"
          ? t("pay.oneTap.amountChanged", { amount: formatUsdLabeled(amount, t.intl) })
          : going?.phase === "declined"
            ? (going.message ?? t("pay.copy.declined"))
            : null;
  return (
    <OneTapBlock
      label={label}
      busy={busy || waiting}
      disabled={ck.running && going === null}
      notice={notice}
      tone={going?.phase === "declined" ? "error" : "info"}
      big={big}
      onTap={() => void ck.payOneTap(request)}
      onAnotherWay={() => void ck.payAnotherWay(request)}
      anotherWayDisabled={busy || waiting}
    />
  );
}

/** BUX-20: the quote offers one tap (or one is under way). */
function oneTapShown(ck: StepCheckout): boolean {
  return Boolean(ck.quote?.one_tap) || ck.oneTap !== null;
}

/** The pay sheet's line: the run and the files it makes (staging
 * 2026-11-05: what's paid for is visible before paying). */
export function payLine(conv: Conversion, t: Tr = EN): string {
  const files = formatsText(conv.params?.formats, t);
  // owner 2026-11-09/10: what's paid for includes Smoother motion and
  // Commercial use
  return [runLine(conv, { price: false }), files, stabilizeRunWords(conv.params, t), commercialRunWords(conv.params, t)]
    .filter(Boolean)
    .join(" · ");
}

/** P1/P3 for the checkout's waiting run; China mode: P6 (no Stripe.js). */
function PaySheetFor({ ck, action }: { ck: StepCheckout; action: string }): JSX.Element | null {
  const t = useT();
  const chinaOff = useChinaPaymentsOff();
  const conv = ck.payNow;
  if (conv === null) return null;
  // owner 2026-11-09: a run with Commercial use (bought, or included by
  // a plan until its renewal) may be used commercially; others are for
  // personal use (Terms "Using your 3D outputs")
  const commercial = commercialRunWords(conv.params, t) !== null;
  if (chinaOff) {
    return (
      <ChinaComingSoonSheet testId="china-sheet" title={t("pay.china.title")} onClose={() => ck.closePayNow(false)} />
    );
  }
  if (chinaPayments()) {
    return (
      <ChinaPaySheet
        conversionId={conv.conversion_id}
        projectId={conv.project_id}
        amountCents={conv.quote.amount_cents}
        subtitle={payLine(conv, t)}
        onClose={(paid) => ck.closePayNow(paid)}
      />
    );
  }
  return (
    <PaySheet
      conversionId={conv.conversion_id}
      amountCents={conv.quote.amount_cents}
      action={action}
      subtitle={payLine(conv, t)}
      billing={conv.billing}
      publishableKey={conv.publishable_key}
      projectId={conv.project_id}
      note={commercial ? undefined : t("pay.copy.personalUseAddOn")}
      onClose={(outcome) => ck.closePayNow(outcome === "paid")}
      // the tracker's poll: an expired or paid run ends "Paying…"
      run={ck.active?.conversion_id === conv.conversion_id ? ck.active : null}
    />
  );
}

/** P14: the charge line under the run button, from how it'd be paid. */
function chargeLineFor(quote: StepQuoteResponse, t: Tr): string {
  if (quote.payment_flow === "free_preview") return t("make.checkout.freePreview");
  if (quote.spend_limit_reached) return t("balance.copy.spendLimitReached");
  // gateway 00166: credit covers it all, nothing goes to a card
  if (coveredByCredit(quote)) return t("make.checkout.paidFromCredit");
  if (quote.payment_flow === "balance") {
    return quote.balance?.reload_cents ? paidFromBalanceReload(quote.balance.reload_cents, t) : t("balance.copy.paidFromBalance");
  }
  if (quote.payment_flow === "after") return chargeAfterCopy(t);
  if (quote.payment_flow === "precharge" || quote.payment_flow === "paynow") {
    return chargeBeforeCopy(t);
  }
  return quote.charge_timing === "before" ? chargeBeforeCopy(t) : chargeAfterCopy(t);
}

/** The run is paid in full from credit (gateway 00166 pay_split). */
export function coveredByCredit(quote: StepQuoteResponse | null | undefined): boolean {
  const s = quote?.pay_split;
  return !!s && s.card_cents === 0 && s.covered_cents > 0;
}

export const PAID_FROM_CREDIT = EN("make.checkout.paidFromCredit");

/** P14: the "?" pop-over, per account state; null = the panel's own. */
function popoverFor(quote: StepQuoteResponse | null, t: Tr): string | null {
  if (quote?.spend_limit_reached || quote?.payment_flow === "free_preview") return null;
  if (coveredByCredit(quote)) return null;
  switch (quote?.payment_flow) {
    case "balance":
      return popBalance(quote.quote.amount_cents, t);
    case "after":
      return t("pay.copy.popAfter");
    case "precharge":
      return t("pay.copy.popPrecharge");
    case "paynow":
      return t("pay.copy.popSheet");
    default:
      return null;
  }
}

/** P14 "Balance short, auto-reload off": "Balance $3.20 · Add funds". */
function BalanceShort({ quote }: { quote: StepQuoteResponse | null }): JSX.Element | null {
  const { openAddFunds } = useBalanceDialogs();
  const t = useT();
  const b = quote?.balance;
  if (!quote || !b || quote.payment_flow === "balance" || quote.spend_limit_reached) return null;
  return (
    <span data-testid="balance-short" className="text-xs text-fg-muted tabular-nums">
      {rich(
        t,
        "make.checkout.balanceShort",
        {
          add: (c) => (
            <button type="button" className="font-medium text-primary hover:underline" onClick={openAddFunds}>
              {c}
            </button>
          ),
        },
        { amount: formatCents(b.available_cents, t) },
      )}
    </span>
  );
}

/** periods with their own words (make.checkout.freePreviews.left.*) */
const PERIODS: ReadonlySet<string> = new Set(["week", "month", "year", "pass"]);

/** "3 of 20 free previews left this month" / "Your first preview is free"
 * from the quote's free_previews.period (00083; Lifelike previews only,
 * no rollover). */
export function freePreviewText(fp: NonNullable<StepQuoteResponse["free_previews"]>, t: Tr = EN): string | null {
  if (fp.period === "first_project" || (fp.period === undefined && fp.intro)) {
    return fp.free ? t("make.checkout.freePreviews.first") : null;
  }
  if (fp.allowance <= 0) return null;
  if (fp.remaining > 0 && fp.daily_left < Math.max(fp.units, 1)) {
    return t("make.checkout.freePreviews.todayUsed");
  }
  const period = fp.period && PERIODS.has(fp.period) ? fp.period : "none";
  return t(`make.checkout.freePreviews.left.${period}`, { remaining: fp.remaining, allowance: fp.allowance });
}

function FreePreviewLine({ quote }: { quote: StepQuoteResponse | null }): JSX.Element | null {
  const t = useT();
  const fp = quote?.free_previews;
  if (!fp) return null;
  const text = freePreviewText(fp, t);
  if (!text) return null;
  return (
    <span data-testid="free-previews" className={`text-xs ${fp.free ? "text-emerald-300" : "text-fg-muted"} tabular-nums`}>
      {text}
    </span>
  );
}

/** P14 "Spend limit reached": Change limit opens P19. */
function ChangeLimit(): JSX.Element {
  const { openSpending } = useBalanceDialogs();
  const t = useT();
  return (
    <button type="button" data-testid="change-limit" className="text-xs font-medium text-primary hover:underline" onClick={openSpending}>
      {t("make.checkout.changeLimit")}
    </button>
  );
}

/** P14 "Under review": paused, with Contact support. */
function UnderReview(): JSX.Element {
  const t = useT();
  return (
    <div data-testid="under-review" className="flex flex-col items-center gap-1.5 text-sm">
      <span className="text-fg-muted">{t("pay.copy.pausedReview")}</span>
      <a href={supportMailto()} className="text-primary hover:underline">
        {t("make.checkout.contactSupport")}
      </a>
    </div>
  );
}

/** The 402 notice with the right escape hatch: onboarding for a missing
 * card, the billing banner's settle flow for an overdue charge, the account
 * page for a declined hold. */
function BillingBlockNotice({ block }: { block: BillingBlock }): JSX.Element {
  const t = useT();
  if (block === "no_payment_method") {
    return (
      <div
        data-testid="billing-block"
        className="rounded-lg border border-edge bg-surface-2 p-3 text-sm"
      >
        <p className="text-fg">
          {t("make.checkout.block.noPaymentMethod")}
        </p>
        <Link
          href="/account/billing"
          className="mt-1 inline-block text-primary hover:underline"
        >
          {t("make.checkout.block.addPaymentMethod")}
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
          {t("make.checkout.block.declined")}
        </p>
        <Link
          href="/account/billing"
          className="mt-1 inline-block text-primary hover:underline"
        >
          {t("make.checkout.block.updatePaymentMethod")}
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
  const t = useT();
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
          {t("make.checkout.getQuote")}
        </Button>
        {ck.quote && !ck.running && !blocked ? (
          <Button onClick={() => void ck.convert(request)}>
            {t("make.checkout.convertPrice", { price: formatCents(ck.quote.quote.amount_cents, t) })}
          </Button>
        ) : null}
        {ck.quote && !ck.running && !blocked ? (
          <span data-testid="charge-timing-hint" className="text-xs text-fg-muted">
            {ck.quote.charge_timing === "before"
              ? chargeBeforeCopy(t)
              : chargeAfterCopy(t)}
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
      <PaySheetFor ck={ck} action={t("make.checkout.convert")} />
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
  /** Plans canvas: between the quote and the button (Quote A's choice,
   * the Business note); given the quote */
  beforeButton?: (quote: StepQuoteResponse) => ReactNode;
  /** Plans canvas: the main button does this instead of starting the run
   * (Quote A's "Subscribe and convert"); never charges by itself */
  primary?: { label: string; onClick: () => void } | null;
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
  beforeButton,
  primary = null,
}: InstantCheckoutProps): JSX.Element {
  const t = useT();
  const status = useBilling().status;
  const underReview = status?.flow_state === "under_review";
  const stopQuoting = disabledReason !== undefined || underReview;
  const key = JSON.stringify(quoteRequest ?? request);
  // ADR 0138 (staging 2026-11-05): one checkout atom for the price box,
  // QuoteView, the button and the pay sheet; a price shows only for the
  // current selections ("Updating…" meanwhile), a run in progress still
  // gets its price, and changes settle 250 ms before they're priced
  const view = quoteView(useAtomValue(ck.scope), key);
  const { quote, quoting, updating } = view;
  const { running, fetchQuote } = ck;
  const error = view.error ?? ck.error;
  const spendLimitReached = t("balance.copy.spendLimitReached");
  const limitReached = quote?.spend_limit_reached === true || error === spendLimitReached;
  const blocked = disabledReason !== undefined || underReview || limitReached;
  const paymentNeeded =
    outstandingCents(status) > 0 || ck.billingBlock === "billing_overdue";
  useAutoQuote({
    scope: ck.scope,
    key,
    stop: stopQuoting,
    quote: (req) => void fetchQuote(req, { keepTracker: true }),
  });
  const retry = (): void =>
    void fetchQuote(JSON.parse(key) as StepConversionRequest, { keepTracker: true });
  const quoteError =
    view.error !== null && !quoting && view.error !== spendLimitReached ? (
      <span className="flex flex-wrap items-center gap-2">
        <span data-testid="quote-error" className="text-sm text-red-400">
          {view.error}
        </span>
        <button
          type="button"
          data-testid="quote-retry"
          onClick={retry}
          className="text-sm text-primary hover:underline"
        >
          {t("make.checkout.retry")}
        </button>
      </span>
    ) : null;
  const pricingText = updating ? t("make.checkout.updating") : t("make.checkout.pricing");
  const runNote = running ? (
    <p data-testid="run-in-progress" className="text-xs text-fg-muted">
      {t("make.checkout.runInProgress")}
    </p>
  ) : null;

  const price = quote
    ? quote.payment_flow === "free_preview"
      ? t("make.checkout.free")
      : formatCents(quote.quote.amount_cents, t)
    : null;
  const sheet = <PaySheetFor ck={ck} action={label} />;
  const chargeText = quote ? chargeLineFor(quote, t) : chargeBeforeCopy(t);
  // P14: the pop-over says how this account pays; the panel's own when the
  // gateway doesn't say
  // nothing to explain when credit pays it all (gateway 00166)
  const popover = coveredByCredit(quote) ? null : (popoverFor(quote, t) ?? explain);
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
  // owner 2026-11-04: size, frame rate and billable length beside the
  // button, at the moment of paying ("4K · 60 fps · 3 min")
  const facts = quote && !blocked ? runFacts(quote.params, quote.quote.breakdown, t) : [];
  // staging 2026-11-05: the files the quote is for, before paying
  const files = quote && !blocked ? formatsText(quote.params?.formats, t) : "";
  const summary =
    facts.length > 0 || files ? (
      <div className="flex flex-col gap-0.5">
        {facts.length > 0 ? (
          <p data-testid="run-summary" className="text-sm font-medium text-fg">
            {facts.join(" · ")}
          </p>
        ) : null}
        {files ? (
          <p data-testid="run-files" className="text-xs text-fg-muted">
            {t("make.checkout.youllGet", { files })}
          </p>
        ) : null}
      </div>
    ) : null;
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
        <FreePreviewLine quote={quote} />
      </span>
    ) : null;
    return (
      <div data-run-panel className="flex flex-col gap-3">
        <section
          data-testid="price-card"
          className="flex flex-col gap-4 rounded-xl border border-edge bg-surface-1 p-5"
        >
          {heading}
          {quote ? (
            <QuoteView result={quote} chargeLine={false} bare />
          ) : stopQuoting ? (
            <p className="text-sm text-fg-muted">{disabledReason}</p>
          ) : quoteError ? (
            quoteError
          ) : (
            <p data-testid="quote-pending" className="text-sm text-fg-muted">
              {pricingText}
            </p>
          )}
          {chargeHint}
          {quote && beforeButton ? beforeButton(quote) : null}
          {summary}
          {owes ? (
            <PayToContinue />
          ) : primary ? (
            <Button
              size="lg"
              data-testid="checkout-main"
              className="w-full"
              disabled={blocked || quote === null || running}
              onClick={primary.onClick}
            >
              {primary.label}
            </Button>
          ) : oneTapShown(ck) && !blocked ? (
            <OneTapFor ck={ck} request={request} />
          ) : (
            <Button
              size="lg"
              data-testid="checkout-main"
              className="w-full"
              disabled={blocked || quote === null || running || ck.converting}
              aria-busy={ck.converting}
              onClick={() => void ck.convert(request)}
            >
              {ck.converting ? t("make.checkout.starting") : price ? t("make.checkout.labelPrice", { label, price }) : label}
            </Button>
          )}
          {runNote}
          {underReview && !owes ? <UnderReview /> : null}
          {after}
          {error && quote && error !== chargeText ? <p className="text-sm text-red-400">{error}</p> : null}
          {ck.billingBlock ? <BillingBlockNotice block={ck.billingBlock} /> : null}
        </section>
        {/* owner 2026-11-05: a run under the fold pins a compact copy */}
        {tracker && ck.active && !TERMINAL_STATES.has(ck.active.state) ? (
          <PinnedRun conversion={ck.active}>{tracker}</PinnedRun>
        ) : (
          tracker
        )}
        {sheet}
        {/* phone (screen 11): the one button stays in reach at the bottom */}
        {owes ? (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-edge bg-surface-1 p-3 pointer-fine:bg-surface-1/95 pointer-fine:backdrop-blur lg:hidden">
            <PayToContinue />
          </div>
        ) : !running ? (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-edge bg-surface-1 p-3 pointer-fine:bg-surface-1/95 pointer-fine:backdrop-blur lg:hidden">
            {facts.length > 0 ? (
              <p data-testid="run-summary-phone" className="mb-2 text-center text-xs text-fg-muted">
                {facts.join(" · ")}
              </p>
            ) : blocked && disabledReason ? (
              <p className="mb-2 text-center text-xs text-fg-muted">{disabledReason}</p>
            ) : null}
            {!primary && oneTapShown(ck) && !blocked ? (
              // BUX-20: the same one tap in reach at the bottom
              <Button
                size="lg"
                data-testid="checkout-main-phone"
                className="w-full tabular-nums"
                disabled={ck.converting || (ck.oneTap !== null && ck.oneTap.phase !== "declined" && ck.oneTap.phase !== "changed")}
                aria-busy={ck.converting || ck.oneTap?.phase === "paying"}
                onClick={() => void ck.payOneTap(request)}
              >
                {ck.converting || ck.oneTap?.phase === "paying" || !(ck.oneTap?.offer ?? quote?.one_tap)
                  ? t("pay.copy.paying")
                  : oneTapLabel((ck.oneTap?.offer ?? quote?.one_tap)!, t, ck.oneTap?.amountCents)}
              </Button>
            ) : (
            <Button
              size="lg"
              data-testid="checkout-main-phone"
              className="w-full"
              disabled={blocked || quote === null || ck.converting}
              aria-busy={ck.converting}
              onClick={primary ? primary.onClick : () => void ck.convert(request)}
            >
              {ck.converting ? t("make.checkout.starting") : primary ? primary.label : price ? t("make.checkout.labelPrice", { label, price }) : label}
            </Button>
            )}
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
      {summary}
      {oneTapShown(ck) && !blocked ? (
        <div className="max-w-sm">
          <OneTapFor ck={ck} request={request} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {oneTapShown(ck) && !blocked ? null : (
        <Button
          size="lg"
          data-testid="checkout-main"
          disabled={blocked || quote === null || running || ck.converting}
          aria-busy={ck.converting}
          onClick={() => void ck.convert(request)}
        >
          {ck.converting ? t("make.checkout.starting") : price ? t("make.checkout.labelPrice", { label, price }) : label}
        </Button>
        )}
        {underReview ? (
          <UnderReview />
        ) : limitReached ? (
          <span className="flex items-center gap-1.5">
            <span data-testid="charge-timing-hint" className="text-xs text-amber-300">
              {spendLimitReached}
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
              {popoverFor(quote, t) ? <p>{popoverFor(quote, t)}</p> : null}
              {explain}
              <QuoteView result={quote} />
            </InfoPopover>
            <BalanceShort quote={quote} />
            <FreePreviewLine quote={quote} />
          </span>
        ) : quoteError ? (
          quoteError
        ) : !running ? (
          <span data-testid="quote-pending" className="text-xs text-fg-muted">
            {pricingText}
          </span>
        ) : null}
      </div>
      {runNote}
      {after}
      {error && !limitReached && !quoteError ? <p className="text-sm text-red-400">{error}</p> : null}
      {ck.billingBlock ? <BillingBlockNotice block={ck.billingBlock} /> : null}
      {tracker}
      {sheet}
    </div>
  );
}
