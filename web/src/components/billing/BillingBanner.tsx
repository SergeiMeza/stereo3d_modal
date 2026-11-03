"use client";

/**
 * The one app-wide payment banner (S3D-22): "There's a problem with your
 * last payment. Update your card." Files stay downloadable; new paid runs
 * wait (gateway 402 payment_method_needed / billing_overdue) until the
 * payment goes through.
 *
 * "Update card" opens the Stripe billing portal. "Try again" hits POST
 * /v1/billing/settle against the current card; a requires_action response
 * is a 3DS challenge completed in place (completeChargeAction).
 */

import { useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";

import { completeChargeAction } from "./settleAction";

/** Injectable for tests (jsdom cannot navigate). */
let navigateExternal = (url: string) => window.location.assign(url);
export function setNavigateExternalForTests(fn: (url: string) => void): void {
  navigateExternal = fn;
}

export const PAYMENT_PROBLEM =
  "There's a problem with your last payment. Update your card.";

/** Open the billing portal to change the card; returns an error sentence
 * or null once the browser is on its way. */
export async function openCardUpdate(
  gateway: ReturnType<typeof useGateway>,
): Promise<string | null> {
  try {
    const { url } = await gateway.createBillingPortalSession(
      window.location.href,
    );
    navigateExternal(url);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Could not open the card page";
  }
}

/** Shown instead of a paid action's button while a payment is needed. */
export function UpdateCardToContinue(): JSX.Element {
  const gateway = useGateway();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div data-testid="billing-block" className="flex flex-wrap items-center gap-3">
      <Button
        onClick={async () => {
          setBusy(true);
          const err = await openCardUpdate(gateway);
          if (err !== null) {
            setMessage(err);
            setBusy(false);
          }
        }}
        disabled={busy}
      >
        Update your card to continue
      </Button>
      {message ? <span className="text-xs text-red-400">{message}</span> : null}
    </div>
  );
}

export function BillingBanner(): JSX.Element | null {
  const { status, refresh } = useBilling();
  const gateway = useGateway();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!status?.delinquent) return null;

  async function retry(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const result = await gateway.settleBilling();
      if (result.settled) {
        await refresh();
        return;
      }
      if (result.requires_action && result.client_secret) {
        const done = await completeChargeAction(
          result.publishable_key,
          result.client_secret,
        );
        if (!done.ok) {
          setMessage(done.error ?? "Confirmation failed");
          return;
        }
        await refresh();
        return;
      }
      setMessage(result.message ?? "The charge was declined again.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  }

  async function updateCard(): Promise<void> {
    setBusy(true);
    setMessage(null);
    const err = await openCardUpdate(gateway);
    if (err !== null) {
      setMessage(err);
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="billing-banner"
      className="border-b border-red-900/60 bg-red-950/40 px-4 py-3"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-red-200">
            {PAYMENT_PROBLEM}
          </p>
          {message ? (
            <p className="mt-1 text-xs text-red-300">{message}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            onClick={() => void updateCard()}
            disabled={busy}
            data-testid="billing-update-card"
          >
            Update card
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void retry()}
            disabled={busy}
            data-testid="billing-retry"
          >
            {busy ? "Working…" : "Try again"}
          </Button>
        </div>
      </div>
    </div>
  );
}
