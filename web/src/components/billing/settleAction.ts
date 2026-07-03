/**
 * Completing a pending 3DS challenge on an outstanding charge. Real mode
 * runs stripe.confirmCardPayment(client_secret) with the saved card; mock
 * mode tells the MSW gateway to settle it (NODE_ENV=test included, same
 * reasoning as the other implementation boundaries).
 */

import { getStripe } from "./stripeLoader";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

export async function completeChargeAction(
  publishableKey: string,
  clientSecret: string,
): Promise<{ ok: boolean; error?: string }> {
  if (
    process.env.NEXT_PUBLIC_API_MOCK === "1" ||
    process.env.NODE_ENV === "test"
  ) {
    const res = await fetch(`${GATEWAY}/__mock__/complete-3ds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_secret: clientSecret }),
    });
    return res.ok
      ? { ok: true }
      : { ok: false, error: `confirmation failed (${res.status})` };
  }
  const stripe = await getStripe(publishableKey);
  if (!stripe) return { ok: false, error: "Stripe failed to load" };
  const result = await stripe.confirmCardPayment(clientSecret);
  if (result.error) {
    return { ok: false, error: result.error.message ?? "confirmation failed" };
  }
  return { ok: true };
}
