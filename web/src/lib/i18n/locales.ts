/**
 * The web app's languages (owner 2026-11-07): no locale in the URL; the
 * NEXT_LOCALE cookie first (the site's name for it), then Accept-Language,
 * then English. ?hl=<code> on any URL sets the cookie (proxy.ts) and is
 * then taken off the address. Listed in the site's order (siteLocales),
 * each in its own name. A language without its messages file yet shows
 * English, key by key (lib/i18n/t.ts).
 */

export const LOCALES = [
  { code: "en", name: "English", intl: "en-US" },
  { code: "zh-Hans", name: "简体中文", intl: "zh-CN" },
  { code: "ja", name: "日本語", intl: "ja-JP" },
  { code: "fr", name: "Français", intl: "fr-FR" },
  { code: "de", name: "Deutsch", intl: "de-DE" },
  { code: "zh-Hant", name: "繁體中文", intl: "zh-TW" },
  { code: "ko", name: "한국어", intl: "ko-KR" },
  { code: "es", name: "Español", intl: "es-419" },
  { code: "ru", name: "Русский", intl: "ru-RU" },
  { code: "tr", name: "Türkçe", intl: "tr-TR" },
  { code: "ar", name: "العربية", intl: "ar" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export const DEFAULT_LOCALE: Locale = "en";

/** The picker's cookie (next-intl's name, as the site uses): a year. */
export const LOCALE_COOKIE = "NEXT_LOCALE";
/** ?hl=<code>: the site's links to the app carry its language. */
export const LOCALE_PARAM = "hl";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const RTL: ReadonlySet<string> = new Set(["ar", "he"]);

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && LOCALES.some((l) => l.code === v);
}

export function dirOf(locale: Locale): "ltr" | "rtl" {
  return RTL.has(locale) ? "rtl" : "ltr";
}

/** The BCP 47 tag the Intl formatters get ("en-US", "zh-CN"…). */
export function intlTag(locale: Locale): string {
  return LOCALES.find((l) => l.code === locale)?.intl ?? "en-US";
}

/** A browser tag to one of ours: zh-TW/HK/MO and zh-Hant → zh-Hant, other
 * zh → zh-Hans, else by its language ("de-AT" → de); null when none fits. */
export function matchTag(tag: string): Locale | null {
  const t = tag.trim().toLowerCase();
  if (!t || t === "*") return null;
  if (t.startsWith("zh")) {
    return /hant|-tw|-hk|-mo/.test(t) ? "zh-Hant" : "zh-Hans";
  }
  const lang = t.split("-")[0];
  const hit = LOCALES.find((l) => l.code.toLowerCase() === lang);
  return hit ? hit.code : null;
}

/** Accept-Language → the best of ours, by q. */
export function fromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const tags = header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag, q: q ? Number(q.slice(2)) || 0 : 1, i };
    })
    .filter((x) => x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of tags) {
    const m = matchTag(tag);
    if (m) return m;
  }
  return null;
}

/** The cookie first, then Accept-Language, then English. */
export function resolveLocale(cookie: string | null | undefined, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(cookie)) return cookie;
  return fromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}
