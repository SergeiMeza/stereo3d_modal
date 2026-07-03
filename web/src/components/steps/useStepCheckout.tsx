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
 */

import Link from "next/link";
import { useRef, useState } from "react";
import type { JSX } from "react";

import { completeChargeAction } from "@/components/billing/settleAction";
import { Button } from "@/components/ui/button";
import { GatewayError } from "@/lib/api/client";
import type {
  Conversion,
  Project,
  StepConversionRequest,
  StepQuoteResponse,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";

import { ConversionTracker } from "./ConversionTracker";
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
  onProjectChanged: () => void;
}

export function useStepCheckout(
  project: Project,
  onProjectChanged: () => void,
): StepCheckout {
  const client = useGateway();
  const billing = useBilling();

  const [quote, setQuote] = useState<StepQuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billingBlock, setBillingBlock] = useState<BillingBlock | null>(null);
  const [active, setActive] = useState<Conversion | null>(null);
  const [settled, setSettled] = useState(false);
  // Idempotency-Key, stable per attempt: minted lazily on the first Convert
  // click and reused on retries so a double-submit can't double-charge.
  const attemptKeyRef = useRef<string | null>(null);

  function invalidate(): void {
    setQuote(null);
    attemptKeyRef.current = null;
  }

  async function fetchQuote(req: StepConversionRequest): Promise<void> {
    setQuoting(true);
    setError(null);
    setBillingBlock(null);
    try {
      const res = await client.quoteStep(project.project_id, req);
      setQuote(res);
      attemptKeyRef.current = null; // fresh quote = fresh attempt
      if (settled) {
        // clear the finished run's tracker before a new attempt
        setActive(null);
        setSettled(false);
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setQuoting(false);
    }
  }

  async function convert(req: StepConversionRequest): Promise<void> {
    attemptKeyRef.current ??= crypto.randomUUID();
    setError(null);
    setBillingBlock(null);
    try {
      const conv = await client.createStepConversion(
        project.project_id,
        req,
        attemptKeyRef.current,
      );
      setActive(conv);
      setSettled(false);
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
          setActive(null);
          attemptKeyRef.current = null; // fresh attempt after a failed confirm
        }
      }
    } catch (e) {
      const block = billingBlockOf(e);
      if (block !== null) {
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
    attemptKeyRef.current = null;
    setSettled(true);
    if (settledConv.state === "succeeded") {
      setQuote(null); // run complete
      // The automatic charge (or its failure) is now on the conversion —
      // refresh so a charge_failed surfaces in the billing banner.
      if (settledConv.billing && settledConv.billing.status !== "charged") {
        void billing.refresh();
      }
    }
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
}

/** The uniform bottom half of every step panel: Get quote / Convert buttons,
 * error line, quote line items, and the conversion tracker. */
export function StepCheckoutSection({
  checkout: ck,
  request,
  trackerDownloads = true,
}: StepCheckoutSectionProps): JSX.Element {
  return (
    <>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          onClick={() => void ck.fetchQuote(request)}
          disabled={ck.quoting}
        >
          Get quote
        </Button>
        {ck.quote && !ck.running ? (
          <Button onClick={() => void ck.convert(request)}>
            Convert · {formatCents(ck.quote.quote.amount_cents)}
          </Button>
        ) : null}
        {ck.quote && !ck.running ? (
          <span className="text-xs text-fg-muted">
            Billed to your saved card when it succeeds
          </span>
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
          showDownloads={trackerDownloads}
        />
      ) : null}
    </>
  );
}
