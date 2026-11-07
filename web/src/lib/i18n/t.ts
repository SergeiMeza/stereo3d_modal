/**
 * Customer copy by key (owner 2026-11-07): t("common.language"),
 * ICU messages ({count, plural, one {# run} other {# runs}}) from
 * messages/<locale>.json. A key the active language lacks reads in
 * English; a key English lacks too reads "" and is logged (a test checks
 * every key in the code exists in en.json, so that never ships).
 *
 * The active language is set once per render of I18nProvider (from the
 * root layout, which reads the cookie and Accept-Language), so plain
 * functions (copy helpers) translate too. Without a provider (unit
 * tests) everything reads English.
 */

import { IntlMessageFormat } from "intl-messageformat";

import en from "../../../messages/en.json";

import { DEFAULT_LOCALE, intlTag, type Locale } from "./locales";

export type Messages = { [key: string]: string | Messages };
export type Values = Record<string, string | number | boolean | Date | null | undefined>;

const EN = en as Messages;

let active: { locale: Locale; messages: Messages | null } = { locale: DEFAULT_LOCALE, messages: null };

/** The provider's language and its messages (null: English only). */
export function setActiveLocale(locale: Locale, messages: Messages | null): void {
  if (active.locale === locale && active.messages === messages) return;
  active = { locale, messages: locale === DEFAULT_LOCALE ? null : messages };
}

export function activeLocale(): Locale {
  return active.locale;
}

/** The active language's Intl tag ("en-US", "de-DE"…). */
export function activeIntl(): string {
  return intlTag(active.locale);
}

function lookup(messages: Messages | null, key: string): string | undefined {
  if (!messages) return undefined;
  let cur: string | Messages | undefined = messages;
  for (const part of key.split(".")) {
    if (cur === undefined || typeof cur === "string") return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

const cache = new Map<string, IntlMessageFormat>();

function formatOne(text: string, tag: string, values?: Values): string {
  if (!values && !text.includes("{")) return text;
  const id = `${tag}\u0000${text}`;
  let f = cache.get(id);
  if (!f) {
    f = new IntlMessageFormat(text, tag, undefined, { ignoreTag: true });
    cache.set(id, f);
  }
  const out = f.format(values as Record<string, string | number | boolean | Date | null | undefined>);
  return Array.isArray(out) ? out.join("") : String(out);
}

/** Has English (and so every language) this key? */
export function hasKey(key: string): boolean {
  return lookup(EN, key) !== undefined;
}

/** A message in one language, falling back to English per key. */
export function translate(locale: Locale, messages: Messages | null, key: string, values?: Values): string {
  const own = locale === DEFAULT_LOCALE ? undefined : lookup(messages, key);
  if (own !== undefined) {
    try {
      return formatOne(own, intlTag(locale), values);
    } catch {
      // a broken translation reads in English
    }
  }
  const base = lookup(EN, key);
  if (base === undefined) {
    if (process.env.NODE_ENV !== "production") console.error(`i18n: no English message for "${key}"`);
    return "";
  }
  return formatOne(base, intlTag(DEFAULT_LOCALE), values);
}

/** A message in the active language. */
export function t(key: string, values?: Values): string {
  return translate(active.locale, active.messages, key, values);
}
