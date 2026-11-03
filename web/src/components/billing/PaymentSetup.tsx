"use client";

/**
 * Card-capture implementation boundary for onboarding. A setup
 * implementation owns the UI that saves a payment method for off-session
 * charges — callers render useBillingSetup().Panel and call refresh() when
 * onSaved fires. Selection mirrors the old checkout boundary: mock mode
 * (NEXT_PUBLIC_API_MOCK=1, and NODE_ENV=test because vitest doesn't load
 * .env.local) posts to the mock gateway's confirm-setup endpoint; otherwise
 * the real Stripe Payment Element binds to a gateway SetupIntent.
 */

import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import type { Appearance } from "@stripe/stripe-js";
import { createContext, useContext, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

import type { BillingSetupTicket } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

import { getStripe } from "./stripeLoader";
import { chinaPayments } from "@/lib/paymentRegion";

/** Shown where the payment form can't load (S3D-60). */
const PAYMENT_UNAVAILABLE = "Payment isn't available in this region yet.";

export interface BillingSetupPanelProps {
  /** Called exactly once, after the processor confirms the card was saved. */
  onSaved: () => void;
}

export interface BillingSetupImplementation {
  name: string;
  Panel: (props: BillingSetupPanelProps) => JSX.Element;
}

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

/** Dark appearance matching the studio theme (globals.css --primary). */
const appearance: Appearance = {
  theme: "night",
  labels: "floating",
  variables: {
    colorPrimary: "#4f8cff",
  },
};

// ------------------------------------------------------------------ stripe

function StripeSetupForm({ onSaved }: { onSaved: () => void }): JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (!stripe || !elements) return;
    setSaving(true);
    setError(null);
    const result = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
    });
    if (result.error) {
      setError(result.error.message ?? "Couldn't save the payment method");
      setSaving(false);
      return;
    }
    onSaved();
  }

  return (
    <div className="space-y-3">
      <PaymentElement onReady={() => setReady(true)} />
      <button
        type="button"
        onClick={() => void save()}
        disabled={!stripe || !elements || !ready || saving}
        className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save payment method"}
      </button>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      <p className="text-xs text-fg-muted">
        Nothing is charged now. Every run shows its price before it starts.
      </p>
    </div>
  );
}

function StripeSetupPanel({ onSaved }: BillingSetupPanelProps): JSX.Element {
  // S3D-60/61: in China mode the payment form's script is never loaded
  const [china] = useState(() => chinaPayments());
  if (china) return <p className="text-sm text-fg-muted">{PAYMENT_UNAVAILABLE}</p>;
  return <StripeSetupLoader onSaved={onSaved} />;
}

function StripeSetupLoader({ onSaved }: BillingSetupPanelProps): JSX.Element {
  const gateway = useGateway();
  const [ticket, setTicket] = useState<BillingSetupTicket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    gateway
      .createBillingSetupIntent()
      .then((t) => {
        if (!cancelled) setTicket(t);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "payment method setup failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  // a payment form that can't load (e.g. a blocked script) reads as one
  // plain sentence, never why
  useEffect(() => {
    if (!ticket) return;
    let cancelled = false;
    getStripe(ticket.publishable_key).then(
      (s) => {
        if (!cancelled && s === null) setUnavailable(true);
      },
      () => {
        if (!cancelled) setUnavailable(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ticket]);

  if (unavailable) {
    return <p className="text-sm text-fg-muted">{PAYMENT_UNAVAILABLE}</p>;
  }
  if (error) {
    return <p className="text-sm text-red-400">{error}</p>;
  }
  if (!ticket) {
    return <p className="text-sm text-fg-muted">Preparing secure card form…</p>;
  }
  return (
    <div data-testid="stripe-setup">
      <Elements
        stripe={getStripe(ticket.publishable_key)}
        options={{ clientSecret: ticket.client_secret, appearance }}
      >
        <StripeSetupForm onSaved={onSaved} />
      </Elements>
    </div>
  );
}

export const stripeBillingSetup: BillingSetupImplementation = {
  name: "stripe",
  Panel: StripeSetupPanel,
};

// -------------------------------------------------------------------- mock

function MockSetupPanel({ onSaved }: BillingSetupPanelProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY}/__mock__/confirm-setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`payment method setup failed (${res.status})`);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "payment method setup failed");
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="mock-setup"
      className="space-y-3 rounded-lg border border-edge bg-surface-2 p-4"
    >
      <p className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
        Card setup (test mode)
      </p>
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save test payment method"}
      </button>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </div>
  );
}

export const mockBillingSetup: BillingSetupImplementation = {
  name: "mock",
  Panel: MockSetupPanel,
};

// ---------------------------------------------------------------- boundary

export function defaultBillingSetup(): BillingSetupImplementation {
  if (
    process.env.NEXT_PUBLIC_API_MOCK === "1" ||
    process.env.NODE_ENV === "test"
  ) {
    return mockBillingSetup;
  }
  return stripeBillingSetup;
}

const BillingSetupContext = createContext<BillingSetupImplementation>(
  defaultBillingSetup(),
);

export function BillingSetupProvider({
  implementation,
  children,
}: {
  implementation: BillingSetupImplementation;
  children: ReactNode;
}): JSX.Element {
  return (
    <BillingSetupContext.Provider value={implementation}>
      {children}
    </BillingSetupContext.Provider>
  );
}

export function useBillingSetup(): BillingSetupImplementation {
  return useContext(BillingSetupContext);
}
