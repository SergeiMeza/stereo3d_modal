/**
 * Business details on invoices (owner 2026-11-04): countries, the tax ID
 * types each offers, and the one-line summary.
 */

import type { CompanyDetails } from "@/lib/api/types";

/** Countries offered first (where most customers are), then the rest by
 * name; ISO 3166-1 alpha-2. */
export const COUNTRIES: [string, string][] = [
  ["US", "United States"],
  ["GB", "United Kingdom"],
  ["JP", "Japan"],
  ["DE", "Germany"],
  ["FR", "France"],
  ["CA", "Canada"],
  ["AU", "Australia"],
  ["AT", "Austria"],
  ["BE", "Belgium"],
  ["CH", "Switzerland"],
  ["CN", "China"],
  ["DK", "Denmark"],
  ["ES", "Spain"],
  ["FI", "Finland"],
  ["HK", "Hong Kong"],
  ["IE", "Ireland"],
  ["IT", "Italy"],
  ["KR", "South Korea"],
  ["NL", "Netherlands"],
  ["NO", "Norway"],
  ["NZ", "New Zealand"],
  ["PL", "Poland"],
  ["PT", "Portugal"],
  ["SE", "Sweden"],
  ["SG", "Singapore"],
  ["TW", "Taiwan"],
];

const EU = new Set([
  "AT",
  "BE",
  "DE",
  "DK",
  "ES",
  "FI",
  "FR",
  "IE",
  "IT",
  "NL",
  "PL",
  "PT",
  "SE",
]);

/** The tax ID types a country offers: [Stripe type, label]. */
export function taxTypesFor(country: string): [string, string][] {
  if (country === "GB") return [["gb_vat", "GB VAT"]];
  if (EU.has(country)) return [["eu_vat", "EU VAT"]];
  const one: Record<string, [string, string]> = {
    US: ["us_ein", "US EIN"],
    CA: ["ca_bn", "Canadian BN"],
    AU: ["au_abn", "Australian ABN"],
    JP: ["jp_cn", "Japanese Corporate Number"],
    CH: ["ch_vat", "Swiss VAT"],
    NO: ["no_vat", "Norwegian VAT"],
    NZ: ["nz_gst", "New Zealand GST"],
    SG: ["sg_uen", "Singapore UEN"],
    KR: ["kr_brn", "Korean BRN"],
    HK: ["hk_br", "Hong Kong BR"],
    TW: ["tw_vat", "Taiwanese VAT"],
    CN: ["cn_tin", "Chinese TIN"],
  };
  return one[country] ? [one[country]] : [];
}

export function countryName(code: string): string {
  return COUNTRIES.find(([c]) => c === code)?.[1] ?? code;
}

/** "Kyoto Films Ltd · GB123456789 · London, UK"; null with nothing set. */
export function companySummary(c: CompanyDetails | null): string | null {
  if (!c) return null;
  const place = c.address?.country
    ? [
        c.address.city,
        c.address.country === "GB" ? "UK" : countryName(c.address.country),
      ]
        .filter(Boolean)
        .join(", ")
    : null;
  return (
    [c.company_name, c.tax_id?.value, place].filter(Boolean).join(" · ") || null
  );
}
