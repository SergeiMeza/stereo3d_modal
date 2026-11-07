/**
 * The messages files the server can send (root layout only: the client
 * gets just the active language's). Add a language here when its file
 * lands in messages/ (see messages/README.md); until then it reads
 * English.
 */

import en from "../../../messages/en.json";
import zhHans from "../../../messages/zh-Hans.json";
import ja from "../../../messages/ja.json";
import fr from "../../../messages/fr.json";
import de from "../../../messages/de.json";
import zhHant from "../../../messages/zh-Hant.json";
import ko from "../../../messages/ko.json";
import es from "../../../messages/es.json";
import ru from "../../../messages/ru.json";
import tr from "../../../messages/tr.json";
import ar from "../../../messages/ar.json";

import type { Locale } from "./locales";
import type { Messages } from "./t";

const CATALOGS: Partial<Record<Locale, Messages>> = {
  en: en as Messages,
  "zh-Hans": zhHans as Messages,
  ja: ja as Messages,
  fr: fr as Messages,
  de: de as Messages,
  "zh-Hant": zhHant as Messages,
  ko: ko as Messages,
  es: es as Messages,
  ru: ru as Messages,
  tr: tr as Messages,
  ar: ar as Messages,
};

/** The language's own messages; null for English or a language not added yet. */
export function messagesFor(locale: Locale): Messages | null {
  if (locale === "en") return null;
  return CATALOGS[locale] ?? null;
}
