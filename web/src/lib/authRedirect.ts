/**
 * Settling an Apple or Google redirect sign-in (phones, headsets), apart
 * from the provider so it can be tested without the SDK.
 *
 * Owner bug 2026-11-05 (iPhone Safari): back from Apple, nothing happened
 * and nothing was said. The answer was read only when this tab had stored
 * its intent, and a null answer ended silently. Now:
 * - it's read when the intent is there, or when the auth SDK itself has a
 *   redirect pending (its sessionStorage key) or the URL carries a
 *   handler's answer;
 * - a stored intent that comes back with no user (or, for a link, without
 *   the provider) says so: "Sign-in with Apple didn't finish. Try again.";
 * - every step is recorded in `authDebugAtom` for the ?authdebug=1 panel
 *   (staging and tests only).
 */

import { atom } from "jotai";

export type RedirectProvider = "apple.com" | "google.com";

export interface RedirectIntent {
  op: "signin" | "link";
  providerId: RedirectProvider;
}

export const REDIRECT_KEY = "s3d-auth-redirect";

/** The auth SDK's own "a redirect is on its way" key in sessionStorage. */
const SDK_PENDING_PREFIX = "firebase:pendingRedirect:";

/** What the auth handler adds to the URL when it hands an answer back. */
const HANDLER_PARAMS = /[?&#](?:apiKey|authType|eventId|firebaseError|providerId)=/;

export function readIntent(storage: Storage | null): { intent: RedirectIntent | null; raw: string | null } {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(REDIRECT_KEY) ?? null;
    if (!raw) return { intent: null, raw: null };
    const v = JSON.parse(raw) as Partial<RedirectIntent>;
    const ok =
      (v.op === "signin" || v.op === "link") &&
      (v.providerId === "apple.com" || v.providerId === "google.com");
    return { intent: ok ? (v as RedirectIntent) : null, raw };
  } catch {
    return { intent: null, raw };
  }
}

/** The SDK or the URL says a redirect answer may be waiting. */
export function redirectPending(storage: Storage | null, href: string): boolean {
  if (HANDLER_PARAMS.test(href)) return true;
  try {
    if (!storage) return false;
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(SDK_PENDING_PREFIX) && storage.getItem(k) !== null) return true;
    }
  } catch {
    // storage blocked
  }
  return false;
}

const PROVIDER_NAME: Record<RedirectProvider, string> = {
  "apple.com": "Apple",
  "google.com": "Google",
};

/** "Sign-in with Apple didn't finish. Try again." */
export function unfinishedMessage(intent: RedirectIntent): string {
  const name = PROVIDER_NAME[intent.providerId];
  return intent.op === "link"
    ? `Connecting ${name} didn't finish. Try again.`
    : `Sign-in with ${name} didn't finish. Try again.`;
}

/** The little the settle needs from a signed-in user. */
export interface RedirectUser {
  uid: string;
  providerData?: readonly { providerId: string }[];
}

export type RedirectOutcome<U extends RedirectUser> =
  /** nothing stored, nothing pending: the answer wasn't asked for */
  | { kind: "skipped" }
  | { kind: "user"; user: U; result: unknown }
  /** a null answer, and nothing was expected or the user is already there */
  | { kind: "none" }
  /** an intent came back empty: say so */
  | { kind: "unfinished"; message: string }
  | { kind: "error"; error: unknown };

export async function settleRedirect<U extends RedirectUser>(deps: {
  intent: RedirectIntent | null;
  pending: boolean;
  getRedirectResult: () => Promise<{ user: U } | null>;
  /** the signed-in user once the SDK has settled its state */
  currentUser: () => Promise<U | null>;
}): Promise<RedirectOutcome<U>> {
  const { intent, pending } = deps;
  if (intent === null && !pending) return { kind: "skipped" };
  let result: { user: U } | null;
  try {
    result = await deps.getRedirectResult();
  } catch (error) {
    return { kind: "error", error };
  }
  if (result?.user) return { kind: "user", user: result.user, result };
  if (intent === null) return { kind: "none" };
  const current = await deps.currentUser().catch(() => null);
  if (intent.op === "signin") {
    return current ? { kind: "none" } : { kind: "unfinished", message: unfinishedMessage(intent) };
  }
  const linked = current?.providerData?.some((p) => p.providerId === intent.providerId) === true;
  return linked ? { kind: "none" } : { kind: "unfinished", message: unfinishedMessage(intent) };
}

// ------------------------------------------------------------- debug

/** What the ?authdebug=1 panel shows (staging and tests only). */
export interface AuthDebug {
  /** the stored intent as it was read, or null */
  intent: string | null;
  pending: boolean;
  ran: boolean;
  /** "user abc123…", "null", "unfinished", "error auth/…: message" */
  outcome: string | null;
  currentUser: boolean | null;
  authDomain: string | null;
  host: string | null;
  at: string | null;
}

export const EMPTY_AUTH_DEBUG: AuthDebug = {
  intent: null,
  pending: false,
  ran: false,
  outcome: null,
  currentUser: null,
  authDomain: null,
  host: null,
  at: null,
};

export const authDebugAtom = atom<AuthDebug>(EMPTY_AUTH_DEBUG);

/** The panel exists outside production builds only (staging is a Vercel
 * preview; tests run with NODE_ENV "test"). */
export const AUTH_DEBUG_ALLOWED =
  (process.env.NEXT_PUBLIC_VERCEL_ENV ?? "production") !== "production" || process.env.NODE_ENV === "test";

export function describeOutcome(o: RedirectOutcome<RedirectUser>): string {
  switch (o.kind) {
    case "skipped":
      return "not read";
    case "user":
      return `user ${o.user.uid.slice(0, 6)}…`;
    case "none":
      return "null";
    case "unfinished":
      return `unfinished: ${o.message}`;
    case "error": {
      const e = o.error as { code?: unknown; message?: unknown } | null;
      const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
      const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(o.error);
      return `error ${code}${code ? ": " : ""}${msg}`;
    }
  }
}
