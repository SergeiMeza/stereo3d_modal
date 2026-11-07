import type { Presentment } from "@/lib/api/types";
import { dirOf } from "@/lib/i18n/locales";
import { EN, type Tr } from "@/lib/i18n/t";

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

const money = new Map<string, Intl.NumberFormat>();
function moneyFormat(locale: string, currency: string): Intl.NumberFormat {
  const id = `${locale}|${currency}`;
  let f = money.get(id);
  if (!f) {
    f = new Intl.NumberFormat(locale, { style: "currency", currency });
    money.set(id, f);
  }
  return f;
}

const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur"]);

/**
 * An amount in any currency, in the currency's own minor units (owner
 * 2026-11-07, Option B): formatMoney(1234, "jpy", "ja-JP") → "￥1,234"
 * (JPY has no minor unit); formatMoney(825, "usd", "en-US") → "$8.25". The minor units come from Intl (JPY and KRW
 * 0, USD and EUR 2, BHD 3); `locale` is the Intl tag (Tr.intl, which keeps
 * Latin digits for Arabic). In a right-to-left language the amount keeps
 * its own order inside a sentence.
 */
export function formatMoney(amountMinor: number, currency: string, locale: string): string {
  const f = moneyFormat(locale, currency.toUpperCase());
  const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
  const text = f.format(Math.trunc(amountMinor) / 10 ** digits);
  const lang = locale.split("-")[0].toLowerCase();
  return RTL_LANGUAGES.has(lang) ? `\u2066${text}\u2069` : text;
}

/** A charge paid in another currency (Stripe Adaptive Pricing): "Paid
 * ¥1,234 ($8.25)". null when it was paid in US dollars (no presentment,
 * or a USD one): the caller shows the USD amount as before. */
export function paidLocal(
  presentment: Presentment | null | undefined,
  usdCents: number,
  t: Tr = EN,
): string | null {
  const local = localAmount(presentment, t);
  if (local === null) return null;
  return t("common.money.paidLocal", { local, usd: formatMoney(usdCents, "usd", t.intl) });
}

/** The local amount alone ("¥1,234"), or null when paid in US dollars. */
export function localAmount(presentment: Presentment | null | undefined, t: Tr = EN): string | null {
  if (!presentment || !presentment.currency || presentment.currency.toLowerCase() === "usd") return null;
  return formatMoney(presentment.amount_minor, presentment.currency, t.intl);
}
