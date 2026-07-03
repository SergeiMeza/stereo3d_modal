/**
 * loadStripe exactly once per publishable key (module-level cache — never
 * called per render; the key arrives at runtime from the gateway). Shared by
 * the onboarding Payment Element and the 3DS confirm fallback.
 */

import { loadStripe } from "@stripe/stripe-js";
import type { Stripe } from "@stripe/stripe-js";

const stripePromises = new Map<string, Promise<Stripe | null>>();

export function getStripe(publishableKey: string): Promise<Stripe | null> {
  let promise = stripePromises.get(publishableKey);
  if (!promise) {
    promise = loadStripe(publishableKey);
    stripePromises.set(publishableKey, promise);
  }
  return promise;
}
