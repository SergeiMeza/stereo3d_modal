"use client";

/**
 * The language for everything under it (owner 2026-11-07), per request:
 * the root layout passes the language it read from the request and that
 * language's messages; components read it with useT(). React context on
 * purpose (an exception to ADR 0138): jotai's default store is one per
 * server process, and the language must be one per request.
 */

import { Direction } from "radix-ui";
import { createContext, useContext, useMemo, type JSX, type ReactNode } from "react";

import { dirOf, type Locale } from "./locales";
import { EN, makeTr, type Messages, type Tr } from "./t";

// eslint-disable-next-line no-restricted-syntax -- per-request language (see above)
const TrContext = createContext<Tr>(EN);

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages | null;
  children: ReactNode;
}): JSX.Element {
  const tr = useMemo(() => makeTr(locale, messages), [locale, messages]);
  // menus, selects and sliders follow the page's direction (Arabic: rtl)
  return (
    <TrContext.Provider value={tr}>
      <Direction.Provider dir={dirOf(locale)}>{children}</Direction.Provider>
    </TrContext.Provider>
  );
}

/** The request's translator (call it with a key and values; .locale, .intl). */
export function useT(): Tr {
  return useContext(TrContext);
}
