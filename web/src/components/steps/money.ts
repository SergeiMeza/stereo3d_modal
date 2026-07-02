/**
 * Money display helpers. Amounts are integer CENTS end-to-end (gateway,
 * quotes, PaymentIntents); dollars exist only as display strings produced
 * here — never as floats.
 */

/** 1234 → "$12.34"; -50 → "−$0.50" (U+2212 minus, as designed). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${dollars}.${String(rem).padStart(2, "0")}`;
}
