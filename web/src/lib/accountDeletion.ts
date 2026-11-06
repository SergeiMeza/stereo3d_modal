/**
 * The 48-hour account deletion (owner 2026-11-07, gateway 00166): a delete
 * waits 48 hours, and signing in before then can keep the account. Words
 * and the prompt's state, shared by Account, the sign-in prompt and the
 * gateway client (a frozen action answers 409 account_pending_deletion).
 * Kept free of UI imports (the client and the test setup load it).
 */

import { atom } from "jotai";

/** "Sun 9 Nov, 14:05" in the viewer's time. */
export function deleteAfterText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "9 Nov": the day alone. */
export function deleteAfterDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** After the delete is confirmed. */
export function scheduledLine(deleteAfter: string): string {
  return `Your account will be deleted on ${deleteAfterText(deleteAfter)}. You can still change your mind: sign in before then.`;
}

/** What a frozen action says (409 account_pending_deletion). */
export function pendingDeletionMessage(deleteAfter: unknown): string {
  return typeof deleteAfter === "string" && deleteAfter
    ? `Your account is set to be deleted on ${deleteAfterText(deleteAfter)}. Keep your account to do this.`
    : "Your account is set to be deleted. Keep your account to do this.";
}

/** The sign-in prompt: whose account, and when it goes; null = none. */
export const deletionPromptAtom = atom<{ uid: string; deleteAfter: string } | null>(null);
