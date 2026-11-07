/**
 * BUX-20 one-tap pay (owner 2026-11-07): a pay-first run or what the
 * account owes, paid with one tap on the saved default that has paid
 * before ("Pay US$3.75 with Visa •••• 4242"), without the sheet. The
 * gateway charges on-session in US dollars (never presented locally, so
 * no local-price line); a bank's check is answered here with
 * stripe.handleNextAction; a decline offers "Pay another way" (the sheet).
 */

import { getStripe } from "@/components/billing/stripeLoader";
import { formatUsdLabeled } from "@/components/steps/money";
import { GatewayError } from "@/lib/api/client";
import type { OneTapOffer } from "@/lib/api/types";
import type { Tr } from "@/lib/i18n/t";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

const WALLETS: Record<string, string> = { apple_pay: "Apple Pay", google_pay: "Google Pay" };
const TYPES: Record<string, string> = { link: "Link", paypal: "PayPal", cashapp: "Cash App", klarna: "Klarna" };

function brandName(brand: string): string {
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

/** "Visa •••• 4242", "Apple Pay", "Link · a•••@example.com". */
export function oneTapMethodLabel(offer: OneTapOffer): string {
  const card = offer.brand && offer.last4 ? `${brandName(offer.brand)} •••• ${offer.last4}` : null;
  const wallet = offer.wallet ? WALLETS[offer.wallet] : undefined;
  if (wallet) return wallet;
  // a Link default (its own type, or a card saved through Link)
  if (offer.type === "link" || offer.wallet === "link") {
    return offer.email_masked ? `Link · ${offer.email_masked}` : "Link";
  }
  if (offer.type === "card") return card ?? "Card";
  const name = TYPES[offer.type] ?? offer.type;
  const detail = offer.email_masked ?? card;
  return detail ? `${name} · ${detail}` : name;
}

/** The button: "Pay US$3.75 with Visa •••• 4242" (US dollars say so). */
export function oneTapLabel(offer: OneTapOffer, t: Tr, amountCents = offer.amount_cents): string {
  return t("pay.oneTap.pay", { amount: formatUsdLabeled(amountCents, t.intl), method: oneTapMethodLabel(offer) });
}

/** A one-tap refusal (409), by what the page does next. */
export type OneTapRefusal =
  | { kind: "unavailable" }
  | { kind: "amount_changed"; amountCents: number }
  | { kind: "in_progress" }
  | { kind: "already_paid" }
  | { kind: "stale" }
  /** anything else: the tap can be tried again */
  | { kind: "failed"; message?: string };

export function oneTapRefusal(e: unknown): OneTapRefusal {
  const g = e instanceof GatewayError ? e : null;
  switch (g?.code) {
    case "one_tap_unavailable":
      return { kind: "unavailable" };
    case "amount_changed": {
      const cents = g.details?.amount_cents;
      return typeof cents === "number" ? { kind: "amount_changed", amountCents: cents } : { kind: "stale" };
    }
    case "payment_in_progress":
      return { kind: "in_progress" };
    case "already_paid":
      return { kind: "already_paid" };
    case "expired":
    case "not_payable":
      return { kind: "stale" };
    default:
      return { kind: "failed" };
  }
}

/** How the bank's check on a tap ended. */
export type ActionResult = { status: "succeeded" | "processing" } | { status: "failed"; message?: string };

/** Answers the bank's check on a one-tap payment (requires_action):
 * stripe.handleNextAction in the browser; the mock gateway's stand-in
 * under the mock and tests. */
export async function handleOneTapAction(publishableKey: string | undefined, clientSecret: string): Promise<ActionResult> {
  if (process.env.NEXT_PUBLIC_API_MOCK === "1" || process.env.NODE_ENV === "test") {
    try {
      const res = await fetch(`${GATEWAY}/__mock__/one-tap-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_secret: clientSecret }),
      });
      const body = (await res.json().catch(() => ({}))) as { status?: string; error?: { message?: string } };
      if (!res.ok) return { status: "failed", message: body.error?.message };
      return { status: body.status === "processing" ? "processing" : "succeeded" };
    } catch {
      return { status: "failed" };
    }
  }
  if (!publishableKey) return { status: "failed" };
  const stripe = await getStripe(publishableKey);
  if (!stripe) return { status: "failed" };
  const result = await stripe.handleNextAction({ clientSecret });
  if (result.error) return { status: "failed", message: result.error.message };
  const status = result.paymentIntent?.status;
  if (status === "succeeded") return { status: "succeeded" };
  if (status === "processing") return { status: "processing" };
  return { status: "failed" };
}
