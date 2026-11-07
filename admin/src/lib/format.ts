/** Formatting for amounts and times. Amounts are USD cents. */

/* Stripe's minor units, as the gateway's local_money.go counts them
 * (REV-02): Intl says 0 for HUF, IDR, COP, PKR and ISK where Stripe sends
 * 2, which read 100 times too large. */
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
/** two-decimal in Stripe but written whole when there are no cents, as
 * on the invoices ("HUF 3,990", "NT$317") */
const WHOLE_SHOWN = new Set(["twd", "huf", "isk"]);

/** How many minor units a currency has in Stripe: 0, 3 or 2. */
export function minorUnitsOf(currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** Any currency in its own minor units (owner 2026-11-07, Option B):
 * formatMoney(7480, "jpy") → "¥7,480", formatMoney(760, "eur") → "€7.60",
 * formatMoney(3050, "kwd") → "KWD 3.050". The units are Stripe's, never
 * Intl's. */
export function formatMoney(amountMinor: number, currency: string, locale = "en-US"): string {
  const minor = Math.trunc(amountMinor);
  const units = minorUnitsOf(currency);
  const shown = WHOLE_SHOWN.has(currency.toLowerCase()) && minor % 100 === 0 ? 0 : units;
  const f = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: shown,
    maximumFractionDigits: shown,
  });
  return f.format(minor / 10 ** units);
}

/** US dollars beside another currency, never a bare "$" (owner
 * 2026-11-07): Intl's own US$ where the locale has one, else its code
 * form ("USD 49.72" in en-US). */
export function formatUsdLabeled(cents: number | null | undefined, locale = "en-US"): string {
  const value = Math.trunc(Number(cents ?? 0)) / 100;
  // English "US$49.72", like the invoices and receipts (Intl's en-CA form)
  const tag = locale.split("-")[0].toLowerCase() === "en" ? "en-CA" : locale;
  const symbol = new Intl.NumberFormat(tag, { style: "currency", currency: "USD" });
  const sign = symbol.formatToParts(value).find((p) => p.type === "currency")?.value ?? "";
  const f = /US/.test(sign) ? symbol : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "code" });
  return f.format(value);
}

/** What a card paid in its own currency (Stripe Adaptive Pricing): "Paid
 * ¥7,480 (USD 49.72)"; null when it paid US dollars (null presentment or a
 * USD one), so the caller shows the USD amount as before. */
export function paidLocal(
  presentment: { amount_minor: number; currency: string } | null | undefined,
  usdCents: number | null | undefined,
): string | null {
  if (!presentment?.currency || presentment.currency.toLowerCase() === "usd") return null;
  return `Paid ${formatMoney(presentment.amount_minor, presentment.currency)} (${formatUsdLabeled(usdCents)})`;
}

export function money(cents: number | null | undefined): string {
  const v = Number(cents ?? 0);
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** "12.43" → 1243; returns null when not a valid non-negative amount. */
export function parseDollars(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [d, c = ""] = t.split(".");
  return Number(d) * 100 + Number(c.padEnd(2, "0"));
}

/** Signed variant for balance adjustments: "-5" → -500. */
export function parseSignedDollars(text: string): number | null {
  const t = text.trim();
  const neg = t.startsWith("-");
  const v = parseDollars(neg ? t.slice(1) : t);
  return v === null ? null : neg ? -v : v;
}

export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function pct(v: number | null | undefined, digits = 2): string {
  return `${((v ?? 0) * 100).toFixed(digits)}%`;
}

function valid(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000) return null;
  return d;
}

export function dateTime(iso: string | null | undefined): string {
  const d = valid(iso);
  if (!d) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function dateOnly(iso: string | null | undefined): string {
  const d = valid(iso);
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function time(iso: string | null | undefined): string {
  const d = valid(iso);
  if (!d) return "—";
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ageHours(h: number): string {
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const r = h % 24;
  return r ? `${d}d ${r}h` : `${d}d`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  const d = valid(iso);
  if (!d) return "—";
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** "in 9 h", "in 2 d", "3 h overdue". */
export function until(iso: string | null | undefined, now = Date.now()): string {
  const d = valid(iso);
  if (!d) return "";
  const s = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(s);
  const h = Math.round(abs / 3600);
  const span = abs < 3600 ? `${Math.max(1, Math.round(abs / 60))} min` : h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
  return s >= 0 ? `in ${span}` : `${span} overdue`;
}

/** snake_case → "snake case" for reasons, statuses, kinds. */
export function words(v: string | null | undefined): string {
  return (v ?? "").replace(/_/g, " ");
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}
