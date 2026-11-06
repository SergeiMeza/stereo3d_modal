/**
 * Owner 2026-11-06: "Sensitive operations require fresh sign ins." The
 * gateway answers 401 reauth_required {max_age_s: 300} on sensitive routes
 * (sign-in methods, passkeys, account delete, plan changes, payment
 * methods) when the sign-in is over 5 minutes old. One shared step for
 * all of them: the "Confirm it's you" sheet (ReauthSheet, in the layout)
 * offers the account's ways in, and the request is tried once more.
 *
 * ADR 0138: whether the sheet is open is an app-store atom; the waiting
 * promise is module state, shared by every request that hit the 401 at
 * the same time.
 */

import { atom } from "jotai";

import { appStore } from "@/lib/state/stores";

/** The gateway's codes for "sign in again first". */
const REAUTH_CODES = new Set(["reauth_required", "recent_sign_in_required"]);

export function isReauthCode(code: string | undefined | null): boolean {
  return code !== undefined && code !== null && REAUTH_CODES.has(code);
}

export const NOT_CONFIRMED = "Not confirmed. Nothing was changed.";

/** The person closed the sheet without confirming. */
export class ReauthCancelledError extends Error {
  readonly code = "reauth_cancelled";
  constructor() {
    super(NOT_CONFIRMED);
    this.name = "ReauthCancelledError";
  }
}

/** The sheet is open while a sensitive request waits for it. */
export const reauthOpenAtom = atom(false);

let waiting: Promise<void> | null = null;
let settle: { resolve: () => void; reject: (e: Error) => void } | null = null;

/** Open the sheet (or join the one already open); resolves once the
 * person has signed in again, rejects with ReauthCancelledError. */
export function confirmItsYou(): Promise<void> {
  if (waiting) return waiting;
  waiting = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  appStore.set(reauthOpenAtom, true);
  return waiting;
}

/** The sheet's answer. */
export function finishReauth(confirmed: boolean): void {
  const s = settle;
  settle = null;
  waiting = null;
  appStore.set(reauthOpenAtom, false);
  if (confirmed) s?.resolve();
  else s?.reject(new ReauthCancelledError());
}

/** Test hook. */
export function resetReauthForTests(): void {
  settle = null;
  waiting = null;
  appStore.set(reauthOpenAtom, false);
}
