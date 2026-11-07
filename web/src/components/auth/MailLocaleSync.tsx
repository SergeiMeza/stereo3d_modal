"use client";

/**
 * Customer mails follow the account's language (mail redesign,
 * feat/mail-polish): while someone is signed in, the account's
 * mail_locale is kept at the language they use the web in. It's saved
 * when a session starts with a language other than the saved one, and
 * when the language changes (the picker and ?hl= reload the page with
 * the new one). Debounced, once per language per account; a gateway that
 * doesn't know the field yet is ignored. Never touches `locale` (the
 * Lifelike intro's language).
 */

import { useEffect, useRef } from "react";

import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n/I18nProvider";
import { useAccountSettings } from "@/lib/useAccountSettings";

const DELAY_MS = 1500;
let delayMs = DELAY_MS;

/** Tests: the debounce (default 1.5 s). */
export function setMailLocaleDelayForTests(ms: number | null): void {
  delayMs = ms ?? DELAY_MS;
}

export function MailLocaleSync(): null {
  const { locale } = useT();
  const { user } = useAuth();
  const { settings, update } = useAccountSettings();
  // what this page already sent, per account: one send per change, even
  // when an older gateway answers without the field
  const sent = useRef<string | null>(null);
  const uid = user?.uid ?? null;
  const saved = settings?.mail_locale ?? null;
  const ready = uid !== null && settings !== null;

  useEffect(() => {
    if (!ready) return;
    const key = `${uid}:${locale}`;
    if (saved === locale || sent.current === key) return;
    const timer = window.setTimeout(() => {
      sent.current = key;
      // update() keeps the change on screen and swallows a failure
      update({ mail_locale: locale });
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [ready, uid, locale, saved, update]);

  return null;
}
