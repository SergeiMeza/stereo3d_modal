"use client";

/**
 * ?hl=<code> did its job in proxy.ts (the cookie is set): take it off the
 * address so links copied from here don't carry it (owner 2026-11-07).
 */

import { useEffect } from "react";

import { LOCALE_PARAM } from "./locales";

export function HlParamCleanup(): null {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(LOCALE_PARAM)) return;
    url.searchParams.delete(LOCALE_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  return null;
}
