/**
 * Web Pro on our own Stripe checkout (owner 2026-11-04): useBuyPro(plan)
 * opens the Pro checkout sheet (ProCheckoutHost, mounted once in the
 * layout) and waits for it, so every "Get Pro" button keeps its call.
 */

import type { ProPlan } from "@/lib/pro/plans";

export type ProCheckoutOutcome = "purchased" | "cancelled";

interface Pending {
  plan: ProPlan;
  resolve: (o: ProCheckoutOutcome) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of listeners) l();
};

export function subscribeProCheckout(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function pendingProCheckout(): Pending | null {
  return pending;
}

/** Open the sheet for `plan`; resolves when it closes. */
export function openProCheckout(plan: ProPlan): Promise<ProCheckoutOutcome> {
  pending?.resolve("cancelled");
  return new Promise((resolve) => {
    pending = { plan, resolve };
    emit();
  });
}

export function finishProCheckout(o: ProCheckoutOutcome): void {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(o);
}
