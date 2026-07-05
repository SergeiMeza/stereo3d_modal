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
import type { JSX } from "react";

import { completeChargeAction } from "@/components/billing/settleAction";
import { Button } from "@/components/ui/button";
import { track, upgradeSession } from "@/lib/analytics";
import { GatewayError } from "@/lib/api/client";
import type {
  Conversion,
  Project,
  Step,
  StepConversionRequest,
  StepQuoteResponse,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";

import { stepCheckoutAtom } from "./checkoutStore";
import { ConversionTracker, TERMINAL_STATES } from "./ConversionTracker";
import { formatCents } from "./money";
import { QuoteView } from "./QuoteView";

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : "request failed";
}

/** 402 gate codes the panels route on (lib/api/types.ts APIErrorBody). */
export type BillingBlock =
  | "no_payment_method"
  | "billing_overdue"
  | "card_declined";

function billingBlockOf(e: unknown): BillingBlock | null {
  if (e instanceof GatewayError) {
    if (
      e.code === "no_payment_method" ||
      e.code === "billing_overdue" ||
      e.code === "card_declined"
    ) {
      return e.code;
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
  fetchQuote: (req: StepConversionRequest) => Promise<void>;
  convert: (req: StepConversionRequest) => Promise<void>;
  handleSettled: (settled: Conversion) => void;
  /** Tracker poll snapshots — keeps the shared store current so a remount
   * mid-run resumes from the latest progress, not the creation response. */
  handleUpdate: (conversion: Conversion) => void;
  onProjectChanged: () => void;
}

export function useStepCheckout(
  project: Project,
  step: Step,
  onProjectChanged: () => void,
): StepCheckout {
  const client = useGateway();
  const billing = useBilling();

  // Survives tab navigation (module-scoped jotai store, see checkoutStore).
  const [state, setState] = useAtom(
    stepCheckoutAtom(project.project_id, step),
  );
  const { quote, attemptKey, active, settled } = state;
  // Transient request feedback — a remount clearing these is fine.
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billingBlock, setBillingBlock] = useState<BillingBlock | null>(null);
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
      .filter((c) => c.step === step && !TERMINAL_STATES.has(c.state))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    if (running !== undefined) {
      setState((s) =>
        s.active !== null ? s : { ...s, active: running, settled: false },
      );
    }
  }, [active, conversions, step, setState]);

  // Stable (setState from useAtom is): panels call this from effects that
  // watch priced inputs (e.g. the Depth page's passthrough set).
  const invalidate = useCallback((): void => {
    attemptKeyRef.current = null;
    setState((s) => ({ ...s, quote: null, attemptKey: null }));
  }, [setState]);

  async function fetchQuote(req: StepConversionRequest): Promise<void> {
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
        ...(s.settled ? { active: null, settled: false } : {}),
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
  };
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
          href="/onboarding"
          className="mt-1 inline-block text-primary hover:underline"
        >
          Set up billing →
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
          Your card declined the payment hold for this run — nothing was
          charged.
        </p>
        <Link
          href="/account"
          className="mt-1 inline-block text-primary hover:underline"
        >
          Update your card →
        </Link>
      </div>
    );
  }
  return (
    <div
      data-testid="billing-block"
      className="rounded-lg border border-red-900/60 bg-red-950/40 p-3 text-sm"
    >
      <p className="text-red-200">
        An earlier conversion&apos;s automatic payment failed. Settle it from
        the banner above (or update your card there) to start new work.
      </p>
    </div>
  );
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
          <span className="text-xs text-fg-muted">
            Billed to your saved card when it succeeds
          </span>
        ) : null}
        {blocked ? (
          <span className="text-xs text-amber-400">{disabledReason}</span>
        ) : null}
      </div>
      {ck.error ? <p className="text-sm text-red-400">{ck.error}</p> : null}
      {ck.billingBlock ? <BillingBlockNotice block={ck.billingBlock} /> : null}
      {ck.quote ? <QuoteView result={ck.quote} /> : null}
      {ck.tracking && ck.active ? (
        <ConversionTracker
          conversion={ck.active}
          onProjectChanged={ck.onProjectChanged}
          onSettled={ck.handleSettled}
          onUpdate={ck.handleUpdate}
          showDownloads={trackerDownloads}
        />
      ) : null}
    </>
  );
}
