/**
 * Customer copy by key (owner 2026-11-07): ICU messages
 * ({count, plural, one {# run} other {# runs}}) from
 * messages/<locale>.json. A key the language lacks reads in English; a
 * key English lacks too reads "" and is logged (a test checks every key
 * in the code exists in en.json, so that never ships).
 *
 * The language is per request, never module state: a translator (Tr)
 * comes from useT() in components (the provider's context, set by the
 * root layout from the request), from getServerTr() in server components
 * (lib/i18n/server.ts), and is passed to copy helpers as their last
 * argument (default EN, so unit tests read English).
 */

import { IntlMessageFormat } from "intl-messageformat";

import en from "../../../messages/en.json";

import { ltrRuns } from "./bidi";
import { DEFAULT_LOCALE, dirOf, intlTag, type Locale } from "./locales";

export type Messages = { [key: string]: string | Messages };
export type Values = Record<string, string | number | boolean | Date | null | undefined>;

const EN_MESSAGES = en as Messages;

function lookup(messages: Messages | null, key: string): string | undefined {
  if (!messages) return undefined;
  let cur: string | Messages | undefined = messages;
  for (const part of key.split(".")) {
    if (cur === undefined || typeof cur === "string") return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

// parsed messages, by language and text (immutable once made)
const parsed = new Map<string, IntlMessageFormat>();

function formatOne(text: string, tag: string, values?: Values): string {
  if (!values && !text.includes("{")) return text;
  const id = `${tag}\u0000${text}`;
  let f = parsed.get(id);
  if (!f) {
    f = new IntlMessageFormat(text, tag, undefined, { ignoreTag: true });
    parsed.set(id, f);
  }
  const out = f.format(values);
  return Array.isArray(out) ? out.join("") : String(out);
}

/** Has English (and so every language) this key? */
export function hasKey(key: string): boolean {
  return lookup(EN_MESSAGES, key) !== undefined;
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
  const base = lookup(EN_MESSAGES, key);
  if (base === undefined) {
    if (process.env.NODE_ENV !== "production") console.error(`i18n: no English message for "${key}"`);
    return "";
  }
  return formatOne(base, intlTag(DEFAULT_LOCALE), values);
}

/** One language's translator: tr("ns.key", values), with its language. */
export interface Tr {
  (key: string, values?: Values): string;
  readonly locale: Locale;
  /** the Intl tag for formatters ("en-US", "de-DE"…) */
  readonly intl: string;
  /** the language's own messages (null for English); rich() reads them */
  readonly messages: Messages | null;
}

export function makeTr(locale: Locale, messages: Messages | null): Tr {
  const own = locale === DEFAULT_LOCALE ? null : messages;
  // right to left: numbers and Latin runs inside a message keep their own
  // order ("1920×1080", "8K", "24 fps", "about 12 min")
  const rtl = dirOf(locale) === "rtl";
  const fn = ((key: string, values?: Values) => {
    const out = translate(locale, own, key, values);
    return rtl ? ltrRuns(out, { locale }) : out;
  }) as Tr;
  Object.defineProperty(fn, "locale", { value: locale });
  Object.defineProperty(fn, "intl", { value: intlTag(locale) });
  Object.defineProperty(fn, "messages", { value: own });
  return fn;
}

/** English: the default for helpers called without a translator. */
export const EN: Tr = makeTr(DEFAULT_LOCALE, null);
