/**
 * Money display helpers. Amounts are integer CENTS end-to-end (gateway,
 * quotes, PaymentIntents); dollars exist only as display strings produced
 * here — never as floats.
 */

/** 1234 → "$12.34"; 150000 → "$1,500.00"; -50 → "−$0.50" (U+2212 minus). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
}

/** Round amounts in rules and headlines: 2500 → "$25", 1250 → "$12.50". */
export function formatCentsShort(cents: number): string {
  return cents % 100 === 0 ? formatCents(cents).replace(/\.00$/, "") : formatCents(cents);
}
