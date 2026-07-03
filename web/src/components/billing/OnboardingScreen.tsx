"use client";

/**
 * /onboarding — the one-time pay-as-you-go setup between sign-up and the
 * studio. Saves a card via a gateway SetupIntent (Payment Element); once
 * GET /v1/billing reports a default payment method (the gateway promotes
 * the just-saved card server-side), the user continues to ?next=
 * (default /projects).
 *
 * Users who already have a card on file skip straight through — the page is
 * safe to land on at any time.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { useBilling } from "@/lib/billing";

import { useBillingSetup } from "./PaymentSetup";

function safeNext(raw: string | null): string {
  if (raw !== null && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/projects";
}

/** GET /v1/billing polls after the card saves — the gateway heals the
 * default payment method on read, so one or two polls normally suffice. */
const CONFIRM_POLLS = 5;
const CONFIRM_POLL_MS = 1200;

export default function OnboardingScreen(): JSX.Element {
  const { status, refresh } = useBilling();
  const setup = useBillingSetup();
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));

  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(false);

  const hasCard = status?.has_payment_method === true;
  useEffect(() => {
    if (hasCard && !doneRef.current) {
      doneRef.current = true;
      router.replace(next);
    }
  }, [hasCard, router, next]);

  async function onSaved(): Promise<void> {
    setConfirming(true);
    setError(null);
    for (let i = 0; i < CONFIRM_POLLS; i++) {
      const s = await refresh();
      if (s?.has_payment_method) return; // the effect above redirects
      await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
    }
    setConfirming(false);
    setError(
      "The card was saved but hasn't shown up yet — retry, or continue and check the Account page.",
    );
  }

  return (
    <section className="mx-auto w-full max-w-md space-y-6 px-4 py-16">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">
          Set up pay-as-you-go billing
        </h1>
        <p className="text-fg-muted">
          Stereo3D Studio has no subscription. Save a card once; each
          conversion step shows its exact price up front and bills the card
          automatically <em>only when it succeeds</em>. Failed runs are never
          charged.
        </p>
      </header>
      <div className="rounded-lg border border-edge bg-surface-1 p-4">
        {confirming ? (
          <p className="text-sm text-fg-muted">Confirming your card…</p>
        ) : (
          <setup.Panel onSaved={() => void onSaved()} />
        )}
        {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      </div>
      <p className="text-xs text-fg-muted">
        Cards are stored by Stripe — the studio never sees the number. Manage
        or remove them anytime from the Account page&apos;s billing portal.
      </p>
    </section>
  );
}
