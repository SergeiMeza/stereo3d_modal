/**
 * Web Pro on our own Stripe checkout (owner 2026-11-04): useBuyPro(plan)
 * opens the Pro checkout sheet (ProCheckoutHost, mounted once in the
 * layout) and waits for it, so every "Get Pro" button keeps its call.
 */

import { atom } from "jotai";

import type { ProPlan } from "@/lib/pro/plans";
import { appStore } from "@/lib/state/stores";

export type ProCheckoutOutcome = "purchased" | "cancelled";

export interface Pending {
  plan: ProPlan;
  resolve: (o: ProCheckoutOutcome) => void;
}

/** ADR 0138: the Pro checkout waiting to be shown, in an app-store atom
 * (it carries the plan and the promise's resolve, nothing secret). */
export const proCheckoutAtom = atom<Pending | null>(null);

export function pendingProCheckout(): Pending | null {
  return appStore.get(proCheckoutAtom);
}

/** Open the sheet for `plan`; resolves when it closes. */
export function openProCheckout(plan: ProPlan): Promise<ProCheckoutOutcome> {
  appStore.get(proCheckoutAtom)?.resolve("cancelled");
  return new Promise((resolve) => {
    appStore.set(proCheckoutAtom, { plan, resolve });
  });
}

export function finishProCheckout(o: ProCheckoutOutcome): void {
  const p = appStore.get(proCheckoutAtom);
  appStore.set(proCheckoutAtom, null);
  p?.resolve(o);
}
