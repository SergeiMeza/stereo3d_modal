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
 *
 * Owner bug 2026-11-05 (iPad Safari: sign-in and Add passkey stayed on
 * "Waiting for your passkey…", no sheet, no /verify): the email field's
 * autofill request (a conditional get) could start after it had been
 * cancelled — the cancel landed while its options were still on the way,
 * so nothing was there to abort — and then nothing could ever abort it
 * (the abort service keeps only the latest request). It outlived the page
 * and Safari queued every later passkey prompt behind it. Now:
 * - one autofill request at a time, and one cancelled while its options
 *   load never starts (a generation count);
 * - every prompt of our own first cancels the autofill request and waits
 *   (briefly) until it has settled;
 * - a prompt that hasn't finished in 60 s is aborted and says so.
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

import { copyKey, keyed } from "@/lib/authErrors";
import { GatewayAuthError } from "@/lib/gatewayAuth";
import { EN } from "@/lib/i18n/t";
import { gatewayFetch } from "@/lib/region";

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

export const NOT_REGISTERED_MESSAGE = EN("auth.passkeyErrors.notRegistered");

/** The gateway's sign-in refusals in plain words (rev 00113), as message keys. */
const SIGN_IN_MESSAGES: Record<string, string> = {
  passkey_not_registered: "auth.passkeyErrors.notRegistered",
  passkey_invalid: "auth.passkeyErrors.didntWork",
  challenge_invalid: "auth.passkeyErrors.didntWork",
  passkey_clone_suspected: "auth.passkeyErrors.cloneSuspected",
  account_unavailable: "auth.errors.accountDisabled",
  sign_in_unavailable: "auth.passkeyErrors.unavailable",
  rate_limited: "auth.passkeyErrors.rateLimited",
};
export const DIDNT_FINISH = EN("auth.passkeyErrors.didntFinish");
/** our own cap on a passkey prompt (the gateway's options say 5 minutes) */
export const CEREMONY_TIMEOUT_MS = 60_000;
/** how long a prompt waits for the autofill request to let go */
const SETTLE_WAIT_MS = 250;

/** A PasskeyError with its message from a key (English; the key travels
 * with it for the screen, lib/authErrors). */
function passkeyError(code: string, key: string, status: number, cancelled = false): PasskeyError {
  return keyed(new PasskeyError(code, EN(key), status, cancelled), key);
}

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
  if (err instanceof GatewayAuthError) return copyKey(new PasskeyError(err.code, err.message, err.status), err);
  const e = err as { name?: string; code?: string; cause?: { name?: string }; message?: string } | null;
  const name = e?.cause?.name ?? e?.name;
  if (name === "NotAllowedError" || name === "AbortError" || e?.code === "ERROR_CEREMONY_ABORTED") {
    return passkeyError("cancelled", "auth.passkeyErrors.closed", 0, true);
  }
  if (e?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") {
    return passkeyError("passkey_exists", "auth.passkeyErrors.exists", 0);
  }
  if (name === "SecurityError") {
    return passkeyError("security", "auth.passkeyErrors.security", 0);
  }
  // an already plain message (e.g. the sign-in after the passkey)
  if (err instanceof Error && err.name === "Error" && err.message) {
    return copyKey(new PasskeyError("failed", err.message, 0), err);
  }
  return passkeyError("passkey_failed", "auth.passkeyErrors.failed", 0);
}

async function anonymousPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await gatewayFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw passkeyError("network", "auth.passkeyErrors.network", 0);
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON answer
  }
  if (!res.ok) {
    const code = typeof parsed.error === "string" ? parsed.error : "passkey_failed";
    const key = SIGN_IN_MESSAGES[code];
    if (key !== undefined) throw passkeyError(code, key, res.status);
    const message = typeof parsed.message === "string" ? parsed.message : `request failed (${res.status})`;
    throw new PasskeyError(code, message, res.status);
  }
  return parsed as T;
}

// ------------------------------------------------- the browser's prompt

/** The autofill request in flight (at most one) and its generation: a
 * cancel bumps the generation, so a request whose options are still
 * loading never starts. */
let conditional: Promise<unknown> | null = null;
let generation = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function abortCeremony(): void {
  try {
    WebAuthnAbortService.cancelCeremony();
  } catch {
    // nothing waiting
  }
}

/** Stop a waiting autofill request, including one still loading its
 * options (on unmount, and before the button's own prompt). */
export function cancelPasskeyRequest(): void {
  generation += 1;
  abortCeremony();
}

/** Cancel the autofill request and wait until it has let go (Safari keeps
 * a new prompt waiting behind one that's still pending). */
export async function settleAutofill(): Promise<void> {
  const pending = conditional;
  cancelPasskeyRequest();
  if (pending) await Promise.race([pending.catch(() => undefined), sleep(SETTLE_WAIT_MS)]);
  conditional = null;
}


/** A prompt of our own, never longer than CEREMONY_TIMEOUT_MS. */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abortCeremony();
      reject(passkeyError("timeout", "auth.passkeyErrors.didntFinish", 0));
    }, CEREMONY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(), timeout]);
  } catch (e) {
    throw toPasskeyError(e);
  } finally {
    clearTimeout(timer);
  }
}

/** Options with our own timeout (the browser ends the prompt too). */
function capped<T extends { timeout?: number }>(o: T): T {
  return { ...o, timeout: Math.min(o.timeout ?? CEREMONY_TIMEOUT_MS, CEREMONY_TIMEOUT_MS) };
}

function fetchSignInOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return anonymousPost(PASSKEY_ROUTES.signInOptions, {}).then((r) =>
    optionsOf<PublicKeyCredentialRequestOptionsJSON>(r),
  );
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
  if (!passkeysSupported()) throw passkeyError("unsupported", "auth.passkeyErrors.unsupported", 0);
  let response: AuthenticationResponseJSON;
  if (opts.autofill === true) {
    // one autofill request at a time
    await settleAutofill();
    const mine = generation;
    const optionsJSON = await fetchSignInOptions();
    // cancelled while its options loaded: never start it
    if (mine !== generation) throw passkeyError("cancelled", "auth.passkeyErrors.closed", 0, true);
    const request = startAuthentication({ optionsJSON, useBrowserAutofill: true });
    conditional = request;
    try {
      response = await request;
    } catch (e) {
      throw toPasskeyError(e);
    } finally {
      if (conditional === request) conditional = null;
    }
  } else {
    await settleAutofill();
    const optionsJSON = capped(await fetchSignInOptions());
    response = await ceremony(() => startAuthentication({ optionsJSON }));
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

/** Test hook: no autofill request. */
export function resetPasskeysForTests(): void {
  conditional = null;
  generation = 0;
}

/** What adding a passkey needs from the gateway client (authenticated). */
export interface PasskeyAccountApi {
  passkeyRegisterOptions(name: string): Promise<unknown>;
  passkeyRegisterVerify(response: RegistrationResponseJSON, name: string): Promise<{ passkey?: Passkey }>;
}

function fetchRegisterOptions(api: PasskeyAccountApi, name: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return api.passkeyRegisterOptions(name).then((r) => optionsOf<PublicKeyCredentialCreationOptionsJSON>(r));
}

/** Create a passkey on this device and save it on the account. */
export async function addPasskey(api: PasskeyAccountApi, name: string): Promise<Passkey | null> {
  if (!passkeysSupported()) throw passkeyError("unsupported", "auth.passkeyErrors.cantAdd", 0);
  // a sign-in page's autofill request must not hold this prompt
  await settleAutofill();
  const optionsJSON = capped(await fetchRegisterOptions(api, name));
  const response: RegistrationResponseJSON = await ceremony(() => startRegistration({ optionsJSON }));
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
