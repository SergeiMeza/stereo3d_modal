"use client";

/**
 * The language picker (owner 2026-11-07): sets NEXT_LOCALE and reloads, so
 * the page renders in it from the server on. Each language in its own name.
 */

import type { JSX } from "react";

import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, LOCALES, type Locale } from "./locales";
import { useT } from "./I18nProvider";

export function setLocaleCookie(locale: Locale): void {
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax${secure}`;
}

export function LanguagePicker({
  className,
  onPick = () => window.location.reload(),
}: {
  className?: string;
  /** after the cookie is set (tests) */
  onPick?: (locale: Locale) => void;
}): JSX.Element {
  const t = useT();
  const current = t.locale;
  return (
    <label className={`inline-flex items-center gap-2 text-xs text-fg-muted ${className ?? ""}`}>
      <span>{t("common.language")}</span>
      <select
        data-testid="language-picker"
        value={current}
        onChange={(e) => {
          const next = e.target.value as Locale;
          setLocaleCookie(next);
          onPick(next);
        }}
        className="rounded-md border border-edge bg-surface-1 px-2 py-1 text-xs text-fg"
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}
