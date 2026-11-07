import { activeIntl, activeLocale } from "@/lib/i18n/t";

/**
 * Money display helpers. Amounts are integer CENTS end-to-end (gateway,
 * quotes, PaymentIntents); dollars exist only as display strings produced
 * here — never as floats.
 */

/** 1234 → "$12.34"; 150000 → "$1,500.00"; -50 → "−$0.50" (U+2212 minus). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(Math.trunc(cents));
  // owner 2026-11-07: other languages write USD their own way ("1.500,00 $")
  if (activeLocale() !== "en") return `${sign}${usdFormat(activeIntl()).format(abs / 100)}`;
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
}

const usd = new Map<string, Intl.NumberFormat>();
function usdFormat(tag: string): Intl.NumberFormat {
  let f = usd.get(tag);
  if (!f) {
    f = new Intl.NumberFormat(tag, { style: "currency", currency: "USD" });
    usd.set(tag, f);
  }
  return f;
}

/** Amounts written inside the gateway's text ("Usage credit added ·
 * $1500.00") in the shared format ("$1,500.00"): owner 2026-11-05, every
 * amount on Billing groups its thousands. */
export function groupMoney(text: string): string {
  return text.replace(/([−-]?)\$(\d+)(?:\.(\d{2}))?(?![\d,])/g, (_m, sign: string, whole: string, frac: string | undefined) => {
    const cents = Number(whole) * 100 + (frac ? Number(frac) : 0);
    const out = frac ? formatCents(cents) : formatCentsShort(cents);
    return sign ? `−${out}` : out;
  });
}

/** Round amounts in rules and headlines: 2500 → "$25", 1250 → "$12.50". */
export function formatCentsShort(cents: number): string {
  if (cents % 100 !== 0) return formatCents(cents);
  if (activeLocale() !== "en") {
    const sign = cents < 0 ? "−" : "";
    return `${sign}${new Intl.NumberFormat(activeIntl(), { style: "currency", currency: "USD", maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(Math.abs(cents) / 100)}`;
  }
  return formatCents(cents).replace(/\.00$/, "");
}
