"use client";

/**
 * The active language for everything under it (owner 2026-11-07): the
 * root layout passes the language it picked and that language's messages
 * (English is bundled; a key a language lacks reads in English). It is
 * set for the whole page load: the picker reloads the page.
 */

import type { JSX, ReactNode } from "react";

import type { Locale } from "./locales";
import { activeLocale, setActiveLocale, type Messages } from "./t";

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages | null;
  children: ReactNode;
}): JSX.Element {
  // set during render, before any child reads it (server and client alike)
  setActiveLocale(locale, messages);
  return <>{children}</>;
}

/** The active language. */
export function useLocale(): Locale {
  return activeLocale();
}
