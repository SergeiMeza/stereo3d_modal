import { vi } from "vitest";

/**
 * A fake passkey prompt for jsdom (ADR 0136): PublicKeyCredential exists
 * and navigator.credentials.get/create answer with fixed credentials, or
 * with the error a test sets. With `autofill`, get() waits for the abort
 * signal (a conditional request never resolves on its own).
 */
const buf = (s: string) => new TextEncoder().encode(s).buffer;

export function installWebAuthn(opts: { autofill?: boolean; credentialId?: string } = {}) {
  const fail: { get?: Error; create?: Error } = {};
  const credentialId = opts.credentialId ?? "cred_1";
  const get = vi.fn(async (o: CredentialRequestOptions & { mediation?: string }) => {
    if (o.mediation === "conditional") {
      // waits until the button's request (or the page) cancels it
      return new Promise((_, reject) => {
        o.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    if (fail.get) throw fail.get;
    return {
      id: credentialId,
      rawId: buf(credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        authenticatorData: buf("auth-data"),
        clientDataJSON: buf("client-data"),
        signature: buf("sig"),
        userHandle: buf("dev-user"),
      },
      getClientExtensionResults: () => ({}),
    };
  });
  const create = vi.fn(async () => {
    if (fail.create) throw fail.create;
    return {
      id: "cred_new",
      rawId: buf("cred_new"),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        attestationObject: buf("attestation"),
        clientDataJSON: buf("client-data"),
        getTransports: () => ["internal", "hybrid"],
      },
      getClientExtensionResults: () => ({}),
    };
  });
  const PKC = function PublicKeyCredential() {} as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> };
  PKC.isConditionalMediationAvailable = async () => opts.autofill === true;
  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = PKC;
  Object.defineProperty(navigator, "credentials", { value: { get, create }, configurable: true });
  return {
    get,
    create,
    fail,
    uninstall() {
      delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
      Object.defineProperty(navigator, "credentials", { value: undefined, configurable: true });
    },
  };
}

export const notAllowed = () =>
  Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
