"use client";

/**
 * The account's running tab. Succeeded steps are no longer charged one by
 * one: they accumulate into a single payment that goes through when the
 * batch window closes, when the total reaches the account's cap, or when
 * the user pays now. Shown on /account; the cap grows with spend history
 * (the gateway's batch tiers), which the tier line explains.
 */

import { useState } from "react";
import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";

import { completeChargeAction } from "./settleAction";

function formatDue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PendingBalance(): JSX.Element | null {
  const { status, refresh } = useBilling();
  const gateway = useGateway();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (status === null) return null;
  const pending = status.pending;
  const tier = status.tier;

  async function payNow(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const result = await gateway.payBillingNow();
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
      setMessage(result.message ?? "The payment could not be taken.");
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="pending-balance">
      {pending && pending.amount_cents > 0 ? (
        <>
          <p className="text-fg">
            Pending balance:{" "}
            <span className="font-medium" data-testid="pending-amount">
              {formatCents(pending.amount_cents)}
            </span>{" "}
            {pending.currency.toUpperCase()} · {pending.items.length}{" "}
            {pending.items.length === 1 ? "step" : "steps"}
          </p>
          <p className="text-xs text-fg-muted">
            Charged as one payment by {formatDue(pending.due_at)}, or sooner
            once it reaches {formatCents(pending.cap_cents)}.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void payNow()}
              disabled={busy}
              data-testid="pay-now"
            >
              {busy ? "Working…" : "Pay now"}
            </Button>
            {message ? (
              <span className="text-xs text-destructive">{message}</span>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-fg-muted">No pending balance.</p>
      )}
      {tier ? (
        <p className="text-xs text-fg-muted" data-testid="tier-line">
          Steps are grouped into one payment per {tier.window_hours} hours, up
          to {formatCents(tier.cap_cents)} per payment
          {tier.next_tier
            ? ` — rises to ${formatCents(tier.next_tier.cap_cents)} after ${formatCents(tier.next_tier.min_paid_cents)} in total spend`
            : ""}
          .
        </p>
      ) : null}
    </div>
  );
}
