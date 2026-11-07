/**
 * Sign in with Apple through Apple's own JS, in a popup (owner 2026-11-05).
 * The redirect through the auth handler came back to iPhone Safari with
 * nothing; Apple's popup hands the ID token straight to the page, and the
 * page signs in with it (signInWithCredential), the same apple.com user
 * as the app (same sub, so Pro carries over, S3D-69).
 *
 * The script loads only where Apple is offered (the sign-in page, the
 * account's Add Apple), ahead of the tap: `prepareApple()` loads it and
 * readies a fresh state and nonce, so the tap opens the popup with no
 * network wait in between (Safari blocks popups that come too late).
 * If the script can't load, `AppleJsUnavailable` sends the caller to the
 * redirect fallback.
 */

import { keyed, keyedError } from "@/lib/authErrors";
import { EN } from "@/lib/i18n/t";

export const APPLE_JS_URL =
  "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
export const APPLE_CLIENT_ID = "com.oliver-ai.spatial-photo-studio.web";
const LOAD_TIMEOUT_MS = 10_000;

/** What Apple's script puts on window (only what we use). */
export interface AppleIDAuth {
  init(config: {
    clientId: string;
    scope: string;
    redirectURI: string;
    state: string;
    nonce: string;
    usePopup: boolean;
  }): void;
  signIn(): Promise<{
    authorization: { id_token: string; code?: string; state?: string };
    user?: { email?: string; name?: { firstName?: string; lastName?: string } };
  }>;
}

declare global {
  interface Window {
    AppleID?: { auth: AppleIDAuth };
  }
}

/** The script didn't load: use the redirect fallback. */
export class AppleJsUnavailable extends Error {
  constructor() {
    super(EN("auth.errors.appleUnavailable"));
    this.name = "AppleJsUnavailable";
    keyed(this, "auth.errors.appleUnavailable");
  }
}

/** The person closed Apple's window: a quiet cancel. */
export class AppleCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "AppleCancelled";
  }
}

/** Apple's answer, ready for an apple.com credential. */
export interface AppleAnswer {
  idToken: string;
  rawNonce: string;
  /** only on the first authorization */
  name: string | null;
}

let scriptPromise: Promise<AppleIDAuth> | null = null;

export function loadAppleJs(): Promise<AppleIDAuth> {
  if (typeof window === "undefined") return Promise.reject(new AppleJsUnavailable());
  if (window.AppleID?.auth) return Promise.resolve(window.AppleID.auth);
  scriptPromise ??= new Promise<AppleIDAuth>((resolve, reject) => {
    const fail = () => {
      scriptPromise = null;
      reject(new AppleJsUnavailable());
    };
    const timer = setTimeout(fail, LOAD_TIMEOUT_MS);
    const s = document.createElement("script");
    s.src = APPLE_JS_URL;
    s.async = true;
    s.dataset.appleJs = "1";
    s.onload = () => {
      clearTimeout(timer);
      if (window.AppleID?.auth) resolve(window.AppleID.auth);
      else fail();
    };
    s.onerror = () => {
      clearTimeout(timer);
      s.remove();
      fail();
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Prepared {
  auth: AppleIDAuth;
  state: string;
  rawNonce: string;
}

let prepared: Promise<Prepared> | null = null;

async function prepareOnce(): Promise<Prepared> {
  const auth = await loadAppleJs();
  const state = randomHex(16);
  const rawNonce = randomHex(32);
  auth.init({
    clientId: APPLE_CLIENT_ID,
    scope: "name email",
    redirectURI: `${window.location.origin}/signin`,
    state,
    nonce: await sha256Hex(rawNonce),
    usePopup: true,
  });
  return { auth, state, rawNonce };
}

/** Load the script and ready one sign-in ahead of the tap. Safe to call
 * on every render of a screen that offers Apple. */
export function prepareApple(): void {
  if (prepared) return;
  prepared = prepareOnce();
  prepared.catch(() => {
    prepared = null;
  });
}

const CANCEL_ERRORS = new Set(["popup_closed_by_user", "user_cancelled_authorize"]);

/** Apple's popup: the ID token for this tab's nonce, or AppleCancelled,
 * AppleJsUnavailable, or an Error to show. */
export async function appleAuthorize(): Promise<AppleAnswer> {
  prepareApple();
  const p = await prepared!;
  // one nonce and state per sign-in: the next tap gets fresh ones
  prepared = null;
  let answer: Awaited<ReturnType<AppleIDAuth["signIn"]>>;
  try {
    answer = await p.auth.signIn();
  } catch (e) {
    prepareApple();
    const code = typeof e === "object" && e !== null && "error" in e ? String((e as { error: unknown }).error) : "";
    if (CANCEL_ERRORS.has(code)) throw new AppleCancelled();
    if (code === "popup_blocked_by_browser") {
      throw keyedError("auth.errors.appleBlocked");
    }
    throw keyedError("auth.errors.appleFailed");
  }
  prepareApple();
  const idToken = answer.authorization?.id_token;
  if (!idToken || answer.authorization.state !== p.state) {
    throw keyedError("auth.errors.appleUnfinished");
  }
  const n = answer.user?.name;
  const name = [n?.firstName, n?.lastName].filter((x) => x && x.trim()).join(" ").trim();
  return { idToken, rawNonce: p.rawNonce, name: name || null };
}

/** Test hook: forget the script and the readied sign-in. */
export function resetAppleJsForTests(): void {
  scriptPromise = null;
  prepared = null;
}
