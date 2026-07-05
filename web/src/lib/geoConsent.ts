/**
 * Which visitors must opt in before analytics cookies may be set (UK GDPR /
 * PECR and the EU ePrivacy rules): the UK plus the EEA (EU 27 + Iceland,
 * Liechtenstein, Norway). Shared by the /api/geo route and its tests.
 */

const CONSENT_COUNTRIES = new Set([
  // EU 27
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
  // EEA (non-EU)
  "IS", "LI", "NO",
  // UK
  "GB",
]);

/** `country` is Vercel's x-vercel-ip-country value (ISO 3166-1 alpha-2).
 * Unknown (missing header: local dev, non-Vercel hosts) defaults to
 * requiring consent — the privacy-safe answer. */
export function requiresAnalyticsConsent(country: string | null): boolean {
  if (country === null || country === "") return true;
  return CONSENT_COUNTRIES.has(country.toUpperCase());
}
