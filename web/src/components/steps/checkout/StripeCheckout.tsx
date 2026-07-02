"use client";

/**
 * Real Stripe Payment Element implementation. Binds to the gateway's
 * PaymentIntent (manual capture: the card is held now and captured only when
 * the conversion succeeds) via payment.payment_intent_client_secret. Wallets
 * (Apple Pay / Google Pay) come from the Payment Element's defaults — no
 * custom wallet code.
 */

import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import type { Appearance, Stripe } from "@stripe/stripe-js";
import { useRef, useState } from "react";
import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";

import type {
  CheckoutImplementation,
  CheckoutPanelProps,
} from "./CheckoutProvider";

/** loadStripe exactly once per publishable key (module-level cache — never
 * called per render; the key arrives at runtime in the PaymentSheet). */
const stripePromises = new Map<string, Promise<Stripe | null>>();

function getStripe(publishableKey: string): Promise<Stripe | null> {
  let promise = stripePromises.get(publishableKey);
  if (!promise) {
    promise = loadStripe(publishableKey);
    stripePromises.set(publishableKey, promise);
  }
  return promise;
}

/** Dark appearance matching the studio theme (globals.css --primary). */
const appearance: Appearance = {
  theme: "night",
  labels: "floating",
  variables: {
    colorPrimary: "#4f8cff",
  },
};

/** Statuses that mean "the hold is in place" for a manual-capture intent. */
const PAID_STATUSES = ["requires_capture", "succeeded", "processing"];

function StripePaymentForm({
  session,
  onPaid,
}: CheckoutPanelProps): JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paidRef = useRef(false);

  async function pay(): Promise<void> {
    if (!stripe || !elements) return;
    setConfirming(true);
    setError(null);
    const result = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
    });
    if (result.error) {
      setError(result.error.message ?? "Payment failed");
      setConfirming(false);
      return;
    }
    const status = result.paymentIntent?.status;
    if (status && PAID_STATUSES.includes(status) && !paidRef.current) {
      paidRef.current = true;
      onPaid();
    }
    setConfirming(false);
  }

  return (
    <div className="space-y-3">
      <PaymentElement onReady={() => setReady(true)} />
      <button
        type="button"
        onClick={() => void pay()}
        disabled={!stripe || !elements || !ready || confirming}
        className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
      >
        {confirming
          ? "Confirming…"
          : `Pay ${formatCents(session.amountCents)} ${session.currency.toUpperCase()}`}
      </button>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      <p className="text-xs text-fg-muted">
        Held now — charged only when the conversion succeeds
      </p>
    </div>
  );
}

export function StripeCheckoutPanel({
  session,
  onPaid,
}: CheckoutPanelProps): JSX.Element {
  const stripePromise = getStripe(session.payment.publishable_key);
  return (
    <div
      data-testid="stripe-checkout"
      className="rounded-lg border border-edge bg-surface-2 p-4"
    >
      <Elements
        stripe={stripePromise}
        options={{
          clientSecret: session.payment.payment_intent_client_secret,
          appearance,
        }}
      >
        <StripePaymentForm session={session} onPaid={onPaid} />
      </Elements>
    </div>
  );
}

export const stripeCheckout: CheckoutImplementation = {
  name: "stripe",
  Panel: StripeCheckoutPanel,
};
