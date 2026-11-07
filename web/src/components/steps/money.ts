import { dirOf } from "@/lib/i18n/locales";
import type { Tr } from "@/lib/i18n/t";

/**
 * Money display helpers. Amounts are integer CENTS end-to-end (gateway,
 * quotes, PaymentIntents); dollars exist only as display strings produced
 * here — never as floats.
 */

/** 1234 → "$12.34"; 150000 → "$1,500.00"; -50 → "−$0.50" (U+2212 minus). */
export function formatCents(cents: number, tr?: Pick<Tr, "locale" | "intl">): string {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(Math.trunc(cents));
  // owner 2026-11-07: another language writes USD its own way ("1.500,00 $")
  if (tr && tr.locale !== "en") return isolate(`${sign}${usdFormat(tr.intl, 2).format(abs / 100)}`, tr);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
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
export function formatCentsShort(cents: number, tr?: Pick<Tr, "locale" | "intl">): string {
  if (cents % 100 !== 0) return formatCents(cents, tr);
  if (tr && tr.locale !== "en") return isolate(`${cents < 0 ? "−" : ""}${usdFormat(tr.intl, 0).format(Math.abs(cents) / 100)}`, tr);
  return formatCents(cents).replace(/\.00$/, "");
}

/** In a right-to-left language an amount keeps its own order inside a
 * sentence (Unicode isolates); others get it as is. */
function isolate(text: string, tr: Pick<Tr, "locale">): string {
  return dirOf(tr.locale) === "rtl" ? `\u2066${text}\u2069` : text;
}

const usd = new Map<string, Intl.NumberFormat>();
function usdFormat(tag: string, digits: number): Intl.NumberFormat {
  const id = `${tag}|${digits}`;
  let f = usd.get(id);
  if (!f) {
    f = new Intl.NumberFormat(tag, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
    usd.set(id, f);
  }
  return f;
}
