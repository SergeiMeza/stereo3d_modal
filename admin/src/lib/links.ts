/**
 * Outbound links the console renders come from the gateway (evidence links,
 * the Stripe account-wide view). They are only rendered as links when they
 * are https and point at a host we expect; anything else is shown as text.
 */
const ALLOWED_HOSTS = new Set([
  "dashboard.stripe.com",
  "console.cloud.google.com",
  "modal.com",
]);

export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!ALLOWED_HOSTS.has(url.hostname)) return null;
  return url.toString();
}

/** A short label for a Stripe Dashboard URL: "PaymentIntent", "Customer"… */
export function stripeLinkLabel(url: string): string {
  if (url.includes("/payments/")) return "PaymentIntent";
  if (url.includes("/customers/")) return "Customer";
  if (url.includes("/disputes/")) return "Dispute";
  if (url.includes("/refunds/")) return "Refund";
  if (url.includes("/invoices/")) return "Invoice";
  return "Stripe";
}
