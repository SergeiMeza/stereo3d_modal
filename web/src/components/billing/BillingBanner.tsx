"use client";

/**
 * Delinquency banner. Shown on billing-gated pages when an automatic charge
 * failed after a successful conversion: new paid steps are blocked
 * (gateway 402 billing_overdue) until the debt settles.
 *
 * "Retry charge" hits POST /v1/billing/settle against the CURRENT default
 * card; a requires_action response is a 3DS challenge the user completes
 * in place (completeChargeAction). "Update card" opens the Stripe billing
 * portal — after changing the card there, Retry charge picks it up.
 */

import { useState } from "react";
import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";

import { completeChargeAction } from "./settleAction";

/** Injectable for tests (jsdom cannot navigate). */
let navigateExternal = (url: string) => window.location.assign(url);
export function setNavigateExternalForTests(fn: (url: string) => void): void {
  navigateExternal = fn;
}

export function BillingBanner(): JSX.Element | null {
  const { status, refresh } = useBilling();
  const gateway = useGateway();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!status?.delinquent) return null;

  const totalCents = status.unpaid.reduce((s, u) => s + u.amount_cents, 0);
  const currency = status.unpaid[0]?.currency ?? "usd";

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
    try {
      const { url } = await gateway.createBillingPortalSession(
        window.location.href,
      );
      navigateExternal(url);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not open the portal");
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
            Automatic payment failed — {formatCents(totalCents)}{" "}
            {currency.toUpperCase()} outstanding
          </p>
          <p className="text-xs text-red-200/70">
            Your results stay available, but new conversions are paused until
            the payment goes through
            {status.unpaid[0]
              ? ` (conversion ${status.unpaid[0].conversion_id})`
              : ""}
            .
          </p>
          {message ? (
            <p className="mt-1 text-xs text-red-300">{message}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            onClick={() => void retry()}
            disabled={busy}
            data-testid="billing-retry"
          >
            {busy ? "Working…" : "Retry charge"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void updateCard()}
            disabled={busy}
          >
            Update card
          </Button>
        </div>
      </div>
    </div>
  );
}
