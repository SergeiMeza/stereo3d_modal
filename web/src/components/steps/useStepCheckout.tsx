"use client";

/**
 * Shared quote → checkout → track machinery for the per-step panels
 * (Depth / Stereo / Deliver). Extracted from the old one-size-fits-all
 * StepCard so each panel owns only its parameters; every billing behavior
 * is preserved verbatim:
 *
 * - quotes come from POST /v1/projects/{id}/quotes — no client price math;
 * - a param change INVALIDATES the quote and the pending attempt;
 * - the Idempotency-Key is stable per attempt (minted lazily on the first
 *   Convert click, reused on retries) so a double-submit can't double-charge;
 * - payment-pending (checkout panel) vs running (tracker) are distinct;
 * - onProjectChanged refetches the workspace after a successful run.
 */

import { useRef, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import type {
  Conversion,
  Project,
  StepConversionRequest,
  StepQuoteResponse,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

import { useCheckout } from "./checkout/CheckoutProvider";
import { ConversionTracker } from "./ConversionTracker";
import { formatCents } from "./money";
import { QuoteView } from "./QuoteView";

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : "request failed";
}

export interface StepCheckout {
  quote: StepQuoteResponse | null;
  quoting: boolean;
  error: string | null;
  active: Conversion | null;
  /** paid and being tracked, not yet terminal */
  running: boolean;
  /** created but the payment sheet hasn't been confirmed */
  paymentPending: boolean;
  /** the paid conversion's tracker should stay mounted (incl. after settle) */
  tracking: boolean;
  settled: boolean;
  /** Priced inputs changed — quote (and any pending attempt) is stale. */
  invalidate: () => void;
  fetchQuote: (req: StepConversionRequest) => Promise<void>;
  convert: (req: StepConversionRequest) => Promise<void>;
  markPaid: () => void;
  handleSettled: (settled: Conversion) => void;
  onProjectChanged: () => void;
}

export function useStepCheckout(
  project: Project,
  onProjectChanged: () => void,
): StepCheckout {
  const client = useGateway();

  const [quote, setQuote] = useState<StepQuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Conversion | null>(null);
  const [paidFor, setPaidFor] = useState<string | null>(null);
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
    try {
      const res = await client.quoteStep(project.project_id, req);
      setQuote(res);
      attemptKeyRef.current = null; // fresh quote = fresh attempt
      if (settled) {
        // clear the finished run's tracker before a new attempt
        setActive(null);
        setPaidFor(null);
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
    try {
      const conv = await client.createStepConversion(
        project.project_id,
        req,
        attemptKeyRef.current,
      );
      setActive(conv);
      setSettled(false);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  function markPaid(): void {
    if (active) setPaidFor(active.conversion_id);
  }

  function handleSettled(settledConv: Conversion): void {
    attemptKeyRef.current = null;
    setSettled(true);
    if (settledConv.state === "succeeded") setQuote(null); // run complete
  }

  const tracking = active !== null && paidFor === active.conversion_id;
  const running = tracking && !settled;
  const paymentPending =
    active !== null && paidFor !== active.conversion_id && !settled;

  return {
    quote,
    quoting,
    error,
    active,
    running,
    paymentPending,
    tracking,
    settled,
    invalidate,
    fetchQuote,
    convert,
    markPaid,
    handleSettled,
    onProjectChanged,
  };
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
 * error line, quote line items, payment sheet, and the conversion tracker. */
export function StepCheckoutSection({
  checkout: ck,
  request,
  trackerDownloads = true,
}: StepCheckoutSectionProps): JSX.Element {
  const impl = useCheckout();
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
      </div>
      {ck.error ? <p className="text-sm text-red-400">{ck.error}</p> : null}
      {ck.quote ? <QuoteView result={ck.quote} /> : null}
      {ck.paymentPending && ck.active?.payment ? (
        <impl.Panel
          session={{
            conversionId: ck.active.conversion_id,
            amountCents: ck.active.quote.amount_cents,
            currency: ck.active.quote.currency,
            payment: ck.active.payment,
          }}
          onPaid={ck.markPaid}
        />
      ) : null}
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
