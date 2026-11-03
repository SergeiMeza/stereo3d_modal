/**
 * The small brand mark beside a payment method (mock P10): wallet, card
 * brand or account type, drawn as a text chip — no third-party artwork.
 */

import type { JSX } from "react";

const CHIP: Record<string, { text: string; cls: string }> = {
  apple_pay: { text: " Pay", cls: "bg-white text-black" },
  google_pay: { text: "G Pay", cls: "bg-white text-black" },
  link: { text: "link", cls: "bg-emerald-400 text-black" },
  visa: { text: "VISA", cls: "bg-white text-[#1a1f71] italic" },
  mastercard: { text: "●●", cls: "bg-zinc-800 text-orange-400 tracking-[-0.2em]" },
  amex: { text: "AMEX", cls: "bg-sky-600 text-white" },
  paypal: { text: "PP", cls: "bg-white text-[#003087] italic" },
  balance: { text: "$", cls: "bg-primary/15 text-primary" },
  key: { text: "API", cls: "bg-surface-2 text-fg-muted" },
};

/** "apple_pay", "visa", "paypal"… from a method or a "Visa •••• 4242" label. */
export function badgeKind(m: { type?: string; wallet?: string; brand?: string } | string): string {
  if (typeof m === "string") {
    const l = m.toLowerCase();
    if (l.startsWith("apple pay")) return "apple_pay";
    if (l.startsWith("google pay")) return "google_pay";
    if (l.startsWith("paypal")) return "paypal";
    if (l.startsWith("balance")) return "balance";
    if (l.startsWith("api key")) return "key";
    if (l.startsWith("mastercard")) return "mastercard";
    if (l.startsWith("amex") || l.startsWith("american")) return "amex";
    return "visa";
  }
  return m.wallet ?? (m.type === "card" ? (m.brand ?? "visa") : (m.type ?? "visa"));
}

export function MethodBadge({ kind }: { kind: string }): JSX.Element {
  const c = CHIP[kind] ?? { text: kind.slice(0, 4).toUpperCase(), cls: "bg-surface-2 text-fg-muted" };
  return (
    <span
      aria-hidden
      className={`inline-flex h-5 w-8 shrink-0 items-center justify-center rounded-[4px] text-[9px] font-bold ring-1 ring-foreground/10 ${c.cls}`}
    >
      {c.text}
    </span>
  );
}
