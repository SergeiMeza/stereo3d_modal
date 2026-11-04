import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

import { ApiError, type AdminApi, type PasskeyPurpose } from "./api";
import type { Passkey } from "./types";

/**
 * Passkeys for the console (ADR 0135): Google (Firebase) first, then the
 * passkey; the gateway's session token rides on every admin call
 * (AdminApi.session). Money actions re-assert with the passkey.
 */

export const PASSKEY_COPY = "A passkey uses Face ID, Touch ID, your phone or a security key. Nothing to type.";

/** Asks the browser for the passkey with options already fetched (so the
 * prompt opens straight from the click) and starts or refreshes the
 * session. */
export async function assertPasskey(
  api: AdminApi,
  purpose: PasskeyPurpose,
  options?: PublicKeyCredentialRequestOptionsJSON,
): Promise<void> {
  if (!browserSupportsWebAuthn()) throw new Error(UNSUPPORTED);
  const optionsJSON = options ?? (await api.sessionOptions(purpose));
  const response = await startAuthentication({ optionsJSON });
  await api.sessionVerify(response, purpose);
}

/** Creates a passkey on this device and saves it on the account. */
export async function createPasskey(api: AdminApi, name = deviceName()): Promise<Passkey | null> {
  if (!browserSupportsWebAuthn()) throw new Error(UNSUPPORTED);
  const optionsJSON = await api.registerOptions();
  const response = await startRegistration({ optionsJSON });
  return api.registerVerify(response, name);
}

const UNSUPPORTED = "This browser can't use passkeys. Use a current Safari, Chrome, Edge or Firefox.";

/** A name for a new passkey from the browser, e.g. "Mac · Safari". */
export function deviceName(ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [os, browser].filter(Boolean).join(" · ") || "Passkey";
}

/** Plain words for WebAuthn and gateway failures. */
export function passkeyErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const e = err as { name?: string; code?: string; cause?: { name?: string }; message?: string } | null;
  const name = e?.cause?.name ?? e?.name;
  if (name === "NotAllowedError" || name === "AbortError") return "The passkey prompt was closed or timed out. Try again.";
  if (e?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError")
    return "This device already has a passkey for the console.";
  if (name === "SecurityError") return "This site can't use passkeys here (check the address).";
  return e?.message || "The passkey didn't work. Try again.";
}
