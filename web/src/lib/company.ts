/**
 * Business details on invoices (owner 2026-11-04): countries, the tax ID
 * types each offers, and the one-line summary. Customers are worldwide:
 * every country Stripe Checkout offers for a billing address, named in the
 * page's language (Intl.DisplayNames) and sorted with Intl.Collator. The
 * gateway takes any two-letter code and any tax ID type; Stripe checks
 * them.
 */

import type { CompanyDetails } from "@/lib/api/types";
import { EN, type Tr } from "@/lib/i18n/t";

/**
 * What Stripe Checkout offers for a billing address: every ISO 3166-1
 * alpha-2 code, plus XK (Kosovo, which Stripe offers though it isn't in
 * ISO 3166-1), minus the four Stripe can't serve (CU, IR, KP, SY). One
 * list; names come from Intl, not from here.
 */
export const COUNTRY_CODES: readonly string[] = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ",
  "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CV", "CW", "CX", "CY", "CZ",
  "DE", "DJ", "DK", "DM", "DO", "DZ",
  "EC", "EE", "EG", "EH", "ER", "ES", "ET",
  "FI", "FJ", "FK", "FM", "FO", "FR",
  "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY",
  "HK", "HM", "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IS", "IT",
  "JE", "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KR", "KW", "KY", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
  "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
  "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ",
  "OM",
  "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY",
  "QA",
  "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SZ",
  "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
  "UA", "UG", "UM", "US", "UY", "UZ",
  "VA", "VC", "VE", "VG", "VI", "VN", "VU",
  "WF", "WS",
  "XK",
  "YE", "YT",
  "ZA", "ZM", "ZW",
];

const KNOWN = new Set(COUNTRY_CODES);

export function isCountryCode(code: string | null | undefined): code is string {
  return typeof code === "string" && KNOWN.has(code.toUpperCase());
}

/** The page's language (the html lang), else the browser's, else English. */
export function pageLocale(): string {
  if (typeof document !== "undefined" && document.documentElement.lang) return document.documentElement.lang;
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "en";
}

const namers = new Map<string, Intl.DisplayNames | null>();

function namer(locale: string): Intl.DisplayNames | null {
  if (!namers.has(locale)) {
    try {
      namers.set(locale, new Intl.DisplayNames([locale, "en"], { type: "region" }));
    } catch {
      namers.set(locale, null);
    }
  }
  return namers.get(locale) ?? null;
}

/** "VN" → "Vietnam" in the page's language; the code when Intl can't say. */
export function countryName(code: string, locale = pageLocale()): string {
  const c = code.toUpperCase();
  try {
    const n = namer(locale)?.of(c);
    return n && n !== c ? n : c;
  } catch {
    return c;
  }
}

/** Every country as [code, name], sorted by name in the locale; the
 * detected country is returned apart so the picker can put it first. */
export function countryOptions(
  locale = pageLocale(),
  detected?: string | null,
): { first: [string, string] | null; rest: [string, string][] } {
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  const all = COUNTRY_CODES.map((c): [string, string] => [c, countryName(c, locale)]).sort((a, b) =>
    collator.compare(a[1], b[1]),
  );
  const d = detected?.toUpperCase();
  if (!d || !KNOWN.has(d)) return { first: null, rest: all };
  return { first: all.find(([c]) => c === d) ?? null, rest: all.filter(([c]) => c !== d) };
}

/** A typed or autofilled country (a code, or a name in the page's language
 * or English) → its code. */
export function countryFromText(text: string, locale = pageLocale()): string | null {
  const t = text.trim();
  if (!t) return null;
  if (t.length === 2 && KNOWN.has(t.toUpperCase())) return t.toUpperCase();
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  for (const c of COUNTRY_CODES) {
    if (collator.compare(countryName(c, locale), t) === 0 || collator.compare(countryName(c, "en"), t) === 0) return c;
  }
  return null;
}

/** The country from the browser's language ("en-GB" → GB), if it has one. */
export function localeCountry(): string | null {
  if (typeof navigator === "undefined") return null;
  for (const l of navigator.languages ?? [navigator.language]) {
    try {
      const region = new Intl.Locale(l).maximize().region;
      if (region && KNOWN.has(region)) return region;
    } catch {
      // not a locale
    }
  }
  return null;
}

/** EU members: the EU VAT number. */
const EU = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE",
  "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]);

/**
 * Stripe's customer tax ID types per country (docs.stripe.com/billing/
 * customer/tax-ids, read 2026-11-04), as Stripe types; their labels in
 * plain words are messages (company.taxTypes.<type in camelCase>). EU
 * members also take eu_vat; Great Britain also takes eu_vat for a Northern
 * Ireland number. Countries without a type here need none.
 */
const TAX_TYPES: Record<string, string[]> = {
  AD: ["ad_nrt"],
  AE: ["ae_trn"],
  AL: ["al_tin"],
  AM: ["am_tin"],
  AO: ["ao_tin"],
  AR: ["ar_cuit"],
  AU: [
    "au_abn",
    "au_acn",
    "au_arn",
    "au_wpn",
  ],
  AW: ["aw_tin"],
  AZ: ["az_tin"],
  BA: ["ba_tin"],
  BB: ["bb_tin"],
  BD: ["bd_bin"],
  BF: ["bf_ifu"],
  BG: ["bg_uic"],
  BH: ["bh_vat"],
  BJ: ["bj_ifu"],
  BO: ["bo_tin"],
  BR: [
    "br_cnpj",
    "br_cpf",
  ],
  BS: ["bs_tin"],
  BW: ["bw_vat"],
  BY: ["by_tin"],
  CA: [
    "ca_bn",
    "ca_gst_hst",
    "ca_pst_bc",
    "ca_pst_mb",
    "ca_pst_sk",
    "ca_qst",
  ],
  CD: ["cd_nif"],
  CH: [
    "ch_vat",
    "ch_uid",
  ],
  CI: ["ci_vat"],
  CL: ["cl_tin"],
  CM: ["cm_niu"],
  CN: ["cn_tin"],
  CO: ["co_nit"],
  CR: ["cr_tin"],
  CV: ["cv_nif"],
  CZ: ["cz_dic"],
  DE: ["de_stn"],
  DO: ["do_rcn"],
  EC: ["ec_ruc"],
  EG: ["eg_tin"],
  ES: ["es_cif"],
  ET: ["et_tin"],
  FO: ["fo_vat"],
  FR: [
    "fr_siren",
    "fr_siret",
    "fr_spi",
  ],
  GB: [
    "gb_vat",
    "eu_vat",
  ],
  GE: ["ge_vat"],
  GH: ["gh_tin"],
  GI: ["gi_tin"],
  GN: ["gn_nif"],
  HK: ["hk_br"],
  HR: ["hr_oib"],
  HU: ["hu_tin"],
  ID: ["id_npwp"],
  IL: ["il_vat"],
  IN: ["in_gst"],
  IS: [
    "is_vat",
    "is_kt",
  ],
  IT: ["it_cf"],
  // the T number on qualified invoices first (owner 2026-11-05)
  JP: [
    "jp_trn",
    "jp_cn",
    "jp_rn",
  ],
  KE: ["ke_pin"],
  KG: ["kg_tin"],
  KH: ["kh_tin"],
  KR: ["kr_brn"],
  KZ: ["kz_bin"],
  LA: ["la_tin"],
  LI: [
    "li_vat",
    "li_uid",
  ],
  LK: ["lk_vat"],
  MA: ["ma_vat"],
  MD: [
    "md_vat",
    "md_cf",
  ],
  ME: ["me_pib"],
  MK: ["mk_vat"],
  MR: ["mr_nif"],
  MU: ["mu_vat"],
  MX: ["mx_rfc"],
  MY: [
    "my_sst",
    "my_frp",
    "my_itn",
  ],
  MZ: ["mz_nuit"],
  NG: ["ng_tin"],
  NO: [
    "no_vat",
    "no_voec",
  ],
  NP: ["np_pan"],
  NZ: [
    "nz_gst",
    "nz_bn",
  ],
  OM: ["om_vat"],
  PE: ["pe_ruc"],
  PH: ["ph_tin"],
  PL: ["pl_nip"],
  PT: ["pt_nif"],
  PY: ["py_ruc"],
  RO: ["ro_tin"],
  RS: ["rs_pib"],
  RU: [
    "ru_inn",
    "ru_kpp",
  ],
  SA: ["sa_vat"],
  SG: [
    "sg_uen",
    "sg_gst",
  ],
  SI: ["si_tin"],
  SM: ["sm_coe"],
  SN: ["sn_ninea"],
  SR: ["sr_fin"],
  SV: ["sv_nit"],
  TH: ["th_vat"],
  TJ: ["tj_tin"],
  TR: ["tr_tin"],
  TT: [
    "tt_vat",
    "tt_bir",
  ],
  TW: ["tw_vat"],
  TZ: ["tz_vat"],
  UA: ["ua_vat"],
  UG: ["ug_tin"],
  US: ["us_ein"],
  UY: ["uy_ruc"],
  UZ: [
    "uz_tin",
    "uz_vat",
  ],
  VE: ["ve_rif"],
  VN: ["vn_tin"],
  ZA: ["za_vat"],
  ZM: ["zm_tin"],
  ZW: ["zw_tin"],
};

/** A tax ID type's label: "in_gst" → company.taxTypes.inGst. */
function taxLabel(country: string, type: string, t: Tr): string {
  if (type === "eu_vat") return t(country === "GB" ? "company.taxTypes.euVatNorthernIreland" : "company.taxTypes.euVat");
  return t(`company.taxTypes.${type.replace(/_(\w)/g, (_m, ch: string) => ch.toUpperCase())}`);
}

/** The tax ID types a country offers: [Stripe type, label]; EU VAT first
 * for EU members. */
export function taxTypesFor(country: string, t: Tr = EN): [string, string][] {
  const c = country.toUpperCase();
  const own = TAX_TYPES[c] ?? [];
  const types = EU.has(c) ? ["eu_vat", ...own] : own;
  return types.map((type): [string, string] => [type, taxLabel(c, type, t)]);
}

/** "Kyoto Films Ltd · GB123456789 · London, United Kingdom"; null with
 * nothing set. */
export function companySummary(c: CompanyDetails | null, locale = pageLocale()): string | null {
  if (!c) return null;
  const place = c.address?.country
    ? [c.address.city, countryName(c.address.country, locale)].filter(Boolean).join(", ")
    : null;
  return [c.company_name, c.tax_id?.value, place].filter(Boolean).join(" · ") || null;
}
