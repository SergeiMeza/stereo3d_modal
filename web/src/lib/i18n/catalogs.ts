/**
 * The messages files the server can send (root layout only: the client
 * gets just the active language's). Add a language here when its file
 * lands in messages/ (see messages/README.md); until then it reads
 * English.
 */

import en from "../../../messages/en.json";

import type { Locale } from "./locales";
import type { Messages } from "./t";

const CATALOGS: Partial<Record<Locale, Messages>> = {
  en: en as Messages,
};

/** The language's own messages; null for English or a language not added yet. */
export function messagesFor(locale: Locale): Messages | null {
  if (locale === "en") return null;
  return CATALOGS[locale] ?? null;
}
