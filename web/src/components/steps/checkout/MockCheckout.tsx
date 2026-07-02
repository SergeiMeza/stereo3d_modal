"use client";

/**
 * Mock payment implementation: shows the quoted amount and a "Pay (test)"
 * button that hits the mock gateway's confirm-payment endpoint (which flips
 * the conversion created→paid on the next poll). The Stripe Payment Element
 * implementation will replace this Panel without touching callers.
 */

import { useState } from "react";
import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";

import type {
  CheckoutImplementation,
  CheckoutPanelProps,
} from "./CheckoutProvider";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

export function MockCheckout({
  session,
  onPaid,
}: CheckoutPanelProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY}/__mock__/confirm-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversion_id: session.conversionId }),
      });
      if (!res.ok) throw new Error(`payment failed (${res.status})`);
      onPaid();
    } catch (e) {
      setError(e instanceof Error ? e.message : "payment failed");
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="mock-checkout"
      className="rounded-lg border border-edge bg-surface-2 p-4"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Checkout (test mode)
          </p>
          <p className="mt-0.5 text-xs text-fg-muted">
            {formatCents(session.amountCents)}{" "}
            {session.currency.toUpperCase()} — held now, captured when the
            conversion succeeds
          </p>
        </div>
        <button
          type="button"
          onClick={() => void pay()}
          disabled={busy}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? "Paying…" : "Pay (test)"}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
    </div>
  );
}

export const mockCheckout: CheckoutImplementation = {
  name: "mock",
  Panel: MockCheckout,
};
