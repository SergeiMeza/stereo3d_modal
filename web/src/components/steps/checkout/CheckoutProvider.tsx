"use client";

/**
 * Payment implementation boundary. A checkout implementation owns the
 * payment UI for one conversion's PaymentSheet — callers render
 * useCheckout().Panel and never know which processor is behind it.
 * Implementation selection happens HERE, in defaultCheckout(): mock mode
 * (NEXT_PUBLIC_API_MOCK=1) posts to the mock gateway's confirm-payment
 * endpoint; otherwise the real Stripe Payment Element binds to
 * payment.payment_intent_client_secret. NODE_ENV=test also selects the mock
 * because vitest does not load .env.local (so the mock flag is absent there)
 * and the existing checkout-dependent tests rely on MockCheckout.
 */

import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";

import type { PaymentSheet } from "@/lib/api/types";

import { mockCheckout } from "./MockCheckout";
import { stripeCheckout } from "./StripeCheckout";

/** Everything a payment UI needs to confirm one conversion's payment. */
export interface CheckoutSession {
  conversionId: string;
  amountCents: number;
  currency: string;
  payment: PaymentSheet;
}

export interface CheckoutPanelProps {
  session: CheckoutSession;
  /** Called exactly once, after the processor confirms the payment. */
  onPaid: () => void;
}

export interface CheckoutImplementation {
  name: string;
  Panel: (props: CheckoutPanelProps) => JSX.Element;
}

/** Env-selected default implementation (see file-top comment). */
export function defaultCheckout(): CheckoutImplementation {
  if (
    process.env.NEXT_PUBLIC_API_MOCK === "1" ||
    process.env.NODE_ENV === "test"
  ) {
    return mockCheckout;
  }
  return stripeCheckout;
}

const CheckoutContext = createContext<CheckoutImplementation>(
  defaultCheckout(),
);

export function CheckoutProvider({
  implementation,
  children,
}: {
  implementation: CheckoutImplementation;
  children: ReactNode;
}): JSX.Element {
  return (
    <CheckoutContext.Provider value={implementation}>
      {children}
    </CheckoutContext.Provider>
  );
}

export function useCheckout(): CheckoutImplementation {
  return useContext(CheckoutContext);
}
