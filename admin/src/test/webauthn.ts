import { vi } from "vitest";

/**
 * A fake WebAuthn for jsdom: PublicKeyCredential exists and
 * navigator.credentials.get/create answer with fixed credentials, or with
 * the error a test sets.
 */
const buf = (s: string) => new TextEncoder().encode(s).buffer;

export function installWebAuthn() {
  const fail: { get?: Error; create?: Error } = {};
  const get = vi.fn(async (_opts: CredentialRequestOptions) => {
    if (fail.get) throw fail.get;
    return {
      id: "cred_1",
      rawId: buf("cred_1"),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        authenticatorData: buf("auth-data"),
        clientDataJSON: buf("client-data"),
        signature: buf("sig"),
        userHandle: buf("owner"),
      },
      getClientExtensionResults: () => ({}),
    };
  });
  const create = vi.fn(async (_opts: CredentialCreationOptions) => {
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
  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function PublicKeyCredential() {};
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

export const notAllowed = () => Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });

/** Request options as the gateway would send them (base64url). */
export const requestOptions = { challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [], userVerification: "required", timeout: 60000 };
export const creationOptions = {
  challenge: "Y2hhbGxlbmdl",
  rp: { id: "localhost", name: "Spatial Video Studio admin" },
  user: { id: "b3duZXI", name: "owner@example.com", displayName: "owner@example.com" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
  excludeCredentials: [],
  timeout: 60000,
};
