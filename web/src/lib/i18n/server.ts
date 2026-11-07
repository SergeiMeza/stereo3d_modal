/**
 * The request's language in server components (layout, metadata, page
 * titles): NEXT_LOCALE, then Accept-Language, then English, read once per
 * request (React cache), never held in module state. Server only: it
 * reads next/headers.
 */

import { cookies, headers } from "next/headers";
import { cache } from "react";

import { messagesFor } from "./catalogs";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "./locales";
import { makeTr, type Tr } from "./t";

export const getRequestLocale = cache(async (): Promise<Locale> => {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return resolveLocale(c.get(LOCALE_COOKIE)?.value, h.get("accept-language"));
});

export const getServerTr = cache(async (): Promise<Tr> => {
  const locale = await getRequestLocale();
  return makeTr(locale, messagesFor(locale));
});
