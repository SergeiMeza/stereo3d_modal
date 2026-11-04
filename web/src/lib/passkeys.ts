/**
 * Passkey sign-in for customers (ADR 0136). Passkeys are an extra way into
 * an existing account (made with Apple, Google or email first). The
 * gateway checks the passkey and answers a Firebase custom token, which
 * the auth context signs in with (signInWithCustomToken); in China mode,
 * where the Firebase SDK never loads, it answers the session tokens, as
 * the email code does.
 *
 * The routes are the web's working shape until the gateway sends its own;
 * they live in PASSKEY_ROUTES. Options come as {options: {publicKey},
 * expires_at} (as the admin routes do); the publicKey part is what
 * @simplewebauthn takes as optionsJSON.
 */

import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

import { GatewayAuthError } from "@/lib/gatewayAuth";
import { gatewayBaseUrl } from "@/lib/region";

export const PASSKEY_ROUTES = {
  signInOptions: "/v1/auth/passkey/options",
  signInVerify: "/v1/auth/passkey/verify",
  list: "/v1/account/passkeys",
  registerOptions: "/v1/account/passkeys/register/options",
  registerVerify: "/v1/account/passkeys/register/verify",
  item: (id: string) => `/v1/account/passkeys/${encodeURIComponent(id)}`,
};

/** A passkey on the account. */
export interface Passkey {
  id: string;
  name: string;
  /** e.g. "iPhone", "Mac", "Security key" */
  device_hint?: string | null;
  created_at: string;
  last_used_at?: string | null;
}

/** The sign-in answer: a custom token (Firebase) or the session (China mode). */
export interface PasskeySignInAnswer {
  uid: string;
  custom_token?: string;
  email?: string;
  display_name?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export const NOT_REGISTERED_MESSAGE = "This passkey isn't registered here. Sign in another way.";

/** The gateway's sign-in refusals in plain words (rev 00113). */
const SIGN_IN_MESSAGES: Record<string, string> = {
  passkey_not_registered: NOT_REGISTERED_MESSAGE,
  passkey_invalid: "That didn't work. Try again.",
  challenge_invalid: "That didn't work. Try again.",
  passkey_clone_suspected: "This passkey can't be used. Sign in another way.",
  account_unavailable: "This account has been disabled.",
  sign_in_unavailable: "Sign-in isn't available right now. Try again.",
  rate_limited: "Too many tries. Wait a few minutes.",
};
const CLOSED_MESSAGE = "The passkey prompt was closed before it finished. Try again.";
const UNSUPPORTED_MESSAGE = "This browser can't use passkeys. Sign in another way.";

/** A passkey step that didn't work, with the gateway's code when it said one. */
export class PasskeyError extends GatewayAuthError {
  constructor(
    code: string,
    message: string,
    status: number,
    /** the person closed the prompt or it timed out: not worth a red line */
    public readonly cancelled = false,
  ) {
    super(code, message, status);
    this.name = "PasskeyError";
  }
}

/** {options: {publicKey}}, {options}, {publicKey} or bare options → the
 * publicKey part. */
export function optionsOf<T extends object>(raw: unknown): T {
  let o = raw as Record<string, unknown> | null;
  if (o && typeof o.options === "object" && o.options) o = o.options as Record<string, unknown>;
  if (o && typeof o.publicKey === "object" && o.publicKey) o = o.publicKey as Record<string, unknown>;
  return o as T;
}

export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Whether the browser can offer passkeys in the email field's autofill. */
export async function passkeyAutofillSupported(): Promise<boolean> {
  try {
    return passkeysSupported() && (await browserSupportsWebAuthnAutofill());
  } catch {
    return false;
  }
}

/** Plain words for the browser's and the gateway's refusals. */
export function toPasskeyError(err: unknown): PasskeyError {
  if (err instanceof PasskeyError) return err;
  if (err instanceof GatewayAuthError) return new PasskeyError(err.code, err.message, err.status);
  const e = err as { name?: string; code?: string; cause?: { name?: string }; message?: string } | null;
  const name = e?.cause?.name ?? e?.name;
  if (name === "NotAllowedError" || name === "AbortError" || e?.code === "ERROR_CEREMONY_ABORTED") {
    return new PasskeyError("cancelled", CLOSED_MESSAGE, 0, true);
  }
  if (e?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") {
    return new PasskeyError("passkey_exists", "This device already has a passkey for your account.", 0);
  }
  if (name === "SecurityError") {
    return new PasskeyError("security", "Passkeys don't work on this address. Sign in another way.", 0);
  }
  // an already plain message (e.g. the sign-in after the passkey)
  if (err instanceof Error && err.name === "Error" && err.message) {
    return new PasskeyError("failed", err.message, 0);
  }
  return new PasskeyError("passkey_failed", "The passkey didn't work. Try again or sign in another way.", 0);
}

async function anonymousPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${gatewayBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PasskeyError("network", "Couldn't reach the server. Check the connection and try again.", 0);
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON answer
  }
  if (!res.ok) {
    const code = typeof parsed.error === "string" ? parsed.error : "passkey_failed";
    const message =
      SIGN_IN_MESSAGES[code] ?? (typeof parsed.message === "string" ? parsed.message : `request failed (${res.status})`);
    throw new PasskeyError(code, message, res.status);
  }
  return parsed as T;
}

/**
 * Sign in with a passkey: options, the browser's passkey prompt (or, with
 * autofill, the email field's suggestions), then the gateway's check.
 * session: true asks for the session tokens (China mode).
 */
export async function passkeySignIn(
  opts: { autofill?: boolean; session?: boolean } = {},
  retried = false,
): Promise<PasskeySignInAnswer> {
  if (!passkeysSupported()) throw new PasskeyError("unsupported", UNSUPPORTED_MESSAGE, 0);
  const optionsJSON = optionsOf<PublicKeyCredentialRequestOptionsJSON>(
    await anonymousPost(PASSKEY_ROUTES.signInOptions, {}),
  );
  let response: AuthenticationResponseJSON;
  try {
    response = await startAuthentication({ optionsJSON, useBrowserAutofill: opts.autofill === true });
  } catch (e) {
    throw toPasskeyError(e);
  }
  try {
    return await anonymousPost<PasskeySignInAnswer>(PASSKEY_ROUTES.signInVerify, {
      response,
      ...(opts.session ? { session: true } : {}),
    });
  } catch (e) {
    // an expired or used challenge: once more with fresh options
    if (!retried && e instanceof PasskeyError && e.code === "challenge_invalid") return passkeySignIn(opts, true);
    throw e;
  }
}

/** Stop a waiting autofill request (before the button's own prompt). */
export function cancelPasskeyRequest(): void {
  try {
    WebAuthnAbortService.cancelCeremony();
  } catch {
    // nothing waiting
  }
}

/** What adding a passkey needs from the gateway client (authenticated). */
export interface PasskeyAccountApi {
  passkeyRegisterOptions(name: string): Promise<unknown>;
  passkeyRegisterVerify(response: RegistrationResponseJSON, name: string): Promise<{ passkey?: Passkey }>;
}

/** Create a passkey on this device and save it on the account. */
export async function addPasskey(api: PasskeyAccountApi, name: string): Promise<Passkey | null> {
  if (!passkeysSupported()) throw new PasskeyError("unsupported", "This browser can't add passkeys.", 0);
  const optionsJSON = optionsOf<PublicKeyCredentialCreationOptionsJSON>(await api.passkeyRegisterOptions(name));
  let response: RegistrationResponseJSON;
  try {
    response = await startRegistration({ optionsJSON });
  } catch (e) {
    throw toPasskeyError(e);
  }
  const r = await api.passkeyRegisterVerify(response, name);
  return r.passkey ?? null;
}

/** A name for a new passkey from this browser, e.g. "iPhone" or "Mac". */
export function deviceName(ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux PC";
  return "Passkey";
}

/** sessionStorage flag: a sign-in other than a passkey just happened, so
 * the suggestion to add one may show (once per account until dismissed or
 * added; the dismissal is kept on the gateway). */
export const SUGGEST_KEY = "svs_passkey_suggest";

export function markPasskeySuggestion(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(SUGGEST_KEY, "1");
    else window.sessionStorage.removeItem(SUGGEST_KEY);
  } catch {
    // storage blocked: no suggestion
  }
}

export function passkeySuggestionMarked(): boolean {
  try {
    return window.sessionStorage.getItem(SUGGEST_KEY) === "1";
  } catch {
    return false;
  }
}

/** The settings key that keeps the dismissal on the gateway. */
export const SUGGESTION_DISMISSED_KEY = "passkey_suggestion";
