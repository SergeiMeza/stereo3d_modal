/**
 * The 48-hour account deletion (owner 2026-11-07, gateway 00166): a delete
 * waits 48 hours, and signing in before then can keep the account. Words
 * and the prompt's state, shared by Account, the sign-in prompt and the
 * gateway client (a frozen action answers 409 account_pending_deletion).
 * Kept free of UI imports (the client and the test setup load it).
 */

import { atom } from "jotai";

import { EN, type Tr } from "@/lib/i18n/t";

/** "Sun 9 Nov, 14:05" in the viewer's time. */
export function deleteAfterText(iso: string, t: Tr = EN): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(dateTag(t), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "9 Nov": the day alone. */
export function deleteAfterDay(iso: string, t: Tr = EN): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(dateTag(t), { day: "numeric", month: "short" });
}

/** English writes the day first ("9 Nov"); other languages their own way. */
function dateTag(t: Tr): string {
  return t.locale === "en" ? "en-GB" : t.intl;
}

/** After the delete is confirmed. */
export function scheduledLine(deleteAfter: string, t: Tr = EN): string {
  return t("account.deletion.scheduled", { date: deleteAfterText(deleteAfter, t) });
}

/** What a frozen action says (409 account_pending_deletion). */
export function pendingDeletionMessage(deleteAfter: unknown, t: Tr = EN): string {
  return typeof deleteAfter === "string" && deleteAfter
    ? t("account.deletion.pendingOn", { date: deleteAfterText(deleteAfter, t) })
    : t("account.deletion.pending");
}

/** The sign-in prompt: whose account, and when it goes; null = none. */
export const deletionPromptAtom = atom<{ uid: string; deleteAfter: string } | null>(null);
