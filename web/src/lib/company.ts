/**
 * Business details on invoices (owner 2026-11-04): countries, the tax ID
 * types each offers, and the one-line summary. Customers are worldwide:
 * every country Stripe Checkout offers for a billing address, named in the
 * page's language (Intl.DisplayNames) and sorted with Intl.Collator. The
 * gateway takes any two-letter code and any tax ID type; Stripe checks
 * them.
 */

import type { CompanyDetails } from "@/lib/api/types";

/**
 * Every ISO 3166-1 alpha-2 code except the four Stripe can't serve (CU, IR,
 * KP, SY): what Stripe Checkout offers for a billing address. One list;
 * names come from Intl, not from here.
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
 * customer/tax-ids, read 2026-11-04), as [Stripe type, label in plain
 * words]. EU members also take eu_vat; Great Britain also takes eu_vat for
 * a Northern Ireland number. Countries without a type here need none.
 */
const TAX_TYPES: Record<string, [string, string][]> = {
  AD: [["ad_nrt", "Andorran NRT number"]],
  AE: [["ae_trn", "UAE tax registration number (TRN)"]],
  AL: [["al_tin", "Albanian tax ID number"]],
  AM: [["am_tin", "Armenian tax ID number"]],
  AO: [["ao_tin", "Angolan tax ID number"]],
  AR: [["ar_cuit", "Argentine CUIT"]],
  AU: [
    ["au_abn", "Australian Business Number (ABN)"],
    ["au_acn", "Australian Company Number (ACN)"],
    ["au_arn", "Australian Taxation Office reference number"],
    ["au_wpn", "Australian withholding payer number"],
  ],
  AW: [["aw_tin", "Aruban tax ID number"]],
  AZ: [["az_tin", "Azerbaijani tax ID number"]],
  BA: [["ba_tin", "Bosnian tax ID number"]],
  BB: [["bb_tin", "Barbadian tax ID number"]],
  BD: [["bd_bin", "Bangladeshi business ID (BIN)"]],
  BF: [["bf_ifu", "Burkinabe tax ID (IFU)"]],
  BG: [["bg_uic", "Bulgarian company code (UIC)"]],
  BH: [["bh_vat", "Bahraini VAT number"]],
  BJ: [["bj_ifu", "Beninese tax ID (IFU)"]],
  BO: [["bo_tin", "Bolivian tax ID number"]],
  BR: [
    ["br_cnpj", "Brazilian company number (CNPJ)"],
    ["br_cpf", "Brazilian personal tax number (CPF)"],
  ],
  BS: [["bs_tin", "Bahamian tax ID number"]],
  BW: [["bw_vat", "Botswana VAT number"]],
  BY: [["by_tin", "Belarusian tax ID number"]],
  CA: [
    ["ca_bn", "Canadian business number (BN)"],
    ["ca_gst_hst", "Canadian GST/HST number"],
    ["ca_pst_bc", "British Columbia PST number"],
    ["ca_pst_mb", "Manitoba PST number"],
    ["ca_pst_sk", "Saskatchewan PST number"],
    ["ca_qst", "Québec QST number"],
  ],
  CD: [["cd_nif", "Congolese tax ID (NIF)"]],
  CH: [
    ["ch_vat", "Swiss VAT number"],
    ["ch_uid", "Swiss business ID (UID)"],
  ],
  CI: [["ci_vat", "Ivorian VAT number"]],
  CL: [["cl_tin", "Chilean tax ID (RUT)"]],
  CM: [["cm_niu", "Cameroonian tax ID (NIU)"]],
  CN: [["cn_tin", "Chinese tax ID number"]],
  CO: [["co_nit", "Colombian NIT"]],
  CR: [["cr_tin", "Costa Rican tax ID number"]],
  CV: [["cv_nif", "Cape Verdean tax ID (NIF)"]],
  CZ: [["cz_dic", "Czech tax number (DIČ)"]],
  DE: [["de_stn", "German tax number (Steuernummer)"]],
  DO: [["do_rcn", "Dominican RNC"]],
  EC: [["ec_ruc", "Ecuadorian RUC"]],
  EG: [["eg_tin", "Egyptian tax ID number"]],
  ES: [["es_cif", "Spanish NIF"]],
  ET: [["et_tin", "Ethiopian tax ID number"]],
  FO: [["fo_vat", "Faroese VAT number"]],
  FR: [
    ["fr_siren", "French SIREN number"],
    ["fr_siret", "French SIRET number"],
    ["fr_spi", "French tax number (SPI)"],
  ],
  GB: [
    ["gb_vat", "UK VAT number"],
    ["eu_vat", "Northern Ireland VAT number (XI)"],
  ],
  GE: [["ge_vat", "Georgian VAT number"]],
  GH: [["gh_tin", "Ghanaian tax ID number"]],
  GI: [["gi_tin", "Gibraltar tax ID number"]],
  GN: [["gn_nif", "Guinean tax ID (NIF)"]],
  HK: [["hk_br", "Hong Kong business registration number"]],
  HR: [["hr_oib", "Croatian OIB"]],
  HU: [["hu_tin", "Hungarian tax number"]],
  ID: [["id_npwp", "Indonesian NPWP"]],
  IL: [["il_vat", "Israeli VAT number"]],
  IN: [["in_gst", "Indian GST number"]],
  IS: [
    ["is_vat", "Icelandic VAT number"],
    ["is_kt", "Icelandic ID number (kennitala)"],
  ],
  IT: [["it_cf", "Italian tax code (codice fiscale)"]],
  JP: [
    ["jp_cn", "Japanese corporate number"],
    ["jp_trn", "Japanese tax registration number"],
    ["jp_rn", "Japanese registered foreign business number"],
  ],
  KE: [["ke_pin", "Kenyan KRA PIN"]],
  KG: [["kg_tin", "Kyrgyz tax ID number"]],
  KH: [["kh_tin", "Cambodian tax ID number"]],
  KR: [["kr_brn", "Korean business registration number"]],
  KZ: [["kz_bin", "Kazakh business ID (BIN)"]],
  LA: [["la_tin", "Lao tax ID number"]],
  LI: [
    ["li_vat", "Liechtenstein VAT number"],
    ["li_uid", "Liechtenstein business ID (UID)"],
  ],
  LK: [["lk_vat", "Sri Lankan VAT number"]],
  MA: [["ma_vat", "Moroccan VAT number"]],
  MD: [
    ["md_vat", "Moldovan VAT number"],
    ["md_cf", "Moldovan fiscal code"],
  ],
  ME: [["me_pib", "Montenegrin PIB"]],
  MK: [["mk_vat", "North Macedonian VAT number"]],
  MR: [["mr_nif", "Mauritanian tax ID (NIF)"]],
  MU: [["mu_vat", "Mauritian VAT number"]],
  MX: [["mx_rfc", "Mexican RFC"]],
  MY: [
    ["my_sst", "Malaysian SST number"],
    ["my_frp", "Malaysian FRP number"],
    ["my_itn", "Malaysian income tax number"],
  ],
  MZ: [["mz_nuit", "Mozambican NUIT"]],
  NG: [["ng_tin", "Nigerian tax ID number"]],
  NO: [
    ["no_vat", "Norwegian VAT number"],
    ["no_voec", "Norwegian VOEC number"],
  ],
  NP: [["np_pan", "Nepalese PAN"]],
  NZ: [
    ["nz_gst", "New Zealand GST number"],
    ["nz_bn", "New Zealand business number"],
  ],
  OM: [["om_vat", "Omani VAT number"]],
  PE: [["pe_ruc", "Peruvian RUC"]],
  PH: [["ph_tin", "Philippine tax ID number"]],
  PL: [["pl_nip", "Polish NIP"]],
  PT: [["pt_nif", "Portuguese tax number (NIF)"]],
  PY: [["py_ruc", "Paraguayan RUC"]],
  RO: [["ro_tin", "Romanian tax ID number"]],
  RS: [["rs_pib", "Serbian PIB"]],
  RU: [
    ["ru_inn", "Russian INN"],
    ["ru_kpp", "Russian KPP"],
  ],
  SA: [["sa_vat", "Saudi VAT number"]],
  SG: [
    ["sg_uen", "Singapore UEN"],
    ["sg_gst", "Singapore GST number"],
  ],
  SI: [["si_tin", "Slovenian tax number"]],
  SM: [["sm_coe", "San Marino COE number"]],
  SN: [["sn_ninea", "Senegalese NINEA"]],
  SR: [["sr_fin", "Surinamese FIN"]],
  SV: [["sv_nit", "Salvadoran NIT"]],
  TH: [["th_vat", "Thai VAT number"]],
  TJ: [["tj_tin", "Tajik tax ID number"]],
  TR: [["tr_tin", "Turkish tax ID number"]],
  TT: [
    ["tt_vat", "Trinidad and Tobago VAT number"],
    ["tt_bir", "Trinidad and Tobago BIR number"],
  ],
  TW: [["tw_vat", "Taiwanese VAT number (統一編號)"]],
  TZ: [["tz_vat", "Tanzanian VAT number"]],
  UA: [["ua_vat", "Ukrainian VAT number"]],
  UG: [["ug_tin", "Ugandan tax ID number"]],
  US: [["us_ein", "US employer ID (EIN)"]],
  UY: [["uy_ruc", "Uruguayan RUC"]],
  UZ: [
    ["uz_tin", "Uzbek tax ID number"],
    ["uz_vat", "Uzbek VAT number"],
  ],
  VE: [["ve_rif", "Venezuelan RIF"]],
  VN: [["vn_tin", "Vietnamese tax ID number"]],
  ZA: [["za_vat", "South African VAT number"]],
  ZM: [["zm_tin", "Zambian tax ID number"]],
  ZW: [["zw_tin", "Zimbabwean tax ID number"]],
};

/** The tax ID types a country offers: [Stripe type, label]; EU VAT first
 * for EU members. */
export function taxTypesFor(country: string): [string, string][] {
  const c = country.toUpperCase();
  const own = TAX_TYPES[c] ?? [];
  return EU.has(c) ? [["eu_vat", "EU VAT number"], ...own] : own;
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
