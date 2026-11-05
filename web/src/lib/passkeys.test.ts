import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  addPasskey,
  cancelPasskeyRequest,
  CEREMONY_TIMEOUT_MS,
  DIDNT_FINISH,
  optionsOf,
  passkeySignIn,
  resetPasskeysForTests,
} from "@/lib/passkeys";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import { installWebAuthn } from "@/test/webauthn";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
let wa: ReturnType<typeof installWebAuthn> | null = null;
afterEach(() => {
  vi.useRealTimers();
  cancelPasskeyRequest();
  resetPasskeysForTests();
  wa?.uninstall();
  wa = null;
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const registered = () =>
  mockDb.passkeys.push({ id: "cred_1", name: "iPhone", device_hint: "Safari on iPhone", created_at: "2026-11-01T00:00:00Z", last_used_at: null });

describe("passkey sign-in against the gateway's shapes (ADR 0136, rev 00113)", () => {
  it("passes options.publicKey from {options: {publicKey}, expires_at}", () => {
    const pk = { challenge: "Y2g", rpId: "stereo3d.studio" };
    expect(optionsOf({ options: { publicKey: pk }, expires_at: "x" })).toEqual(pk);
    expect(optionsOf({ publicKey: pk })).toEqual(pk);
    expect(optionsOf(pk)).toEqual(pk);
  });

  it("retries once with fresh options on 400 challenge_invalid", async () => {
    wa = installWebAuthn();
    registered();
    mockDb.passkeyVerifyErrors = [{ status: 400, code: "challenge_invalid" }];
    await expect(passkeySignIn()).resolves.toMatchObject({ custom_token: "mock-custom-token" });
    expect(wa.get).toHaveBeenCalledTimes(2);
  });

  it("a second challenge_invalid says to try again", async () => {
    wa = installWebAuthn();
    mockDb.passkeyVerifyErrors = [
      { status: 400, code: "challenge_invalid" },
      { status: 400, code: "challenge_invalid" },
    ];
    await expect(passkeySignIn()).rejects.toMatchObject({ message: "That didn't work. Try again." });
  });

  it.each([
    [404, "passkey_not_registered", "This passkey isn't registered here. Sign in another way."],
    [401, "passkey_invalid", "That didn't work. Try again."],
    [401, "passkey_clone_suspected", "This passkey can't be used. Sign in another way."],
    [403, "account_unavailable", "This account has been disabled."],
    [502, "sign_in_unavailable", "Sign-in isn't available right now. Try again."],
    [429, "rate_limited", "Too many tries. Wait a few minutes."],
  ])("%i %s: %s", async (status, code, message) => {
    wa = installWebAuthn();
    mockDb.passkeyVerifyErrors = [{ status, code }];
    await expect(passkeySignIn()).rejects.toMatchObject({ code, message });
  });
});

/** The email field the autofill request attaches to. */
function field(): void {
  document.body.innerHTML = '<input autocomplete="username webauthn" />';
}

describe("the autofill request never holds a prompt (owner bug 2026-11-05, iPad Safari)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const conditionalCalls = () =>
    wa!.get.mock.calls.filter(([o]) => (o as { mediation?: string }).mediation === "conditional");

  it("an autofill cancelled while its options load never starts (it couldn't be aborted later)", async () => {
    wa = installWebAuthn({ autofill: true });
    field();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let asked = false;
    server.use(
      http.post("*/v1/auth/passkey/options", async () => {
        asked = true;
        await gate;
        return undefined; // then the mock gateway answers
      }),
    );
    const autofill = passkeySignIn({ autofill: true });
    await vi.waitFor(() => expect(asked).toBe(true));
    // the page unmounts (or the button is pressed) while the options load
    cancelPasskeyRequest();
    release();
    await expect(autofill).rejects.toMatchObject({ cancelled: true });
    expect(conditionalCalls()).toHaveLength(0);
  });

  it("the button's prompt aborts the waiting autofill request first, then opens", async () => {
    wa = installWebAuthn({ autofill: true });
    field();
    registered();
    const autofill = passkeySignIn({ autofill: true }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(conditionalCalls()).toHaveLength(1));
    await expect(passkeySignIn()).resolves.toMatchObject({ custom_token: "mock-custom-token" });
    const [first, second] = wa.get.mock.calls.map(([o]) => o as CredentialRequestOptions & { mediation?: string });
    expect(first.mediation).toBe("conditional");
    expect(first.signal?.aborted).toBe(true);
    expect(second.mediation).toBeUndefined();
    expect(await autofill).toMatchObject({ cancelled: true });
  });

  it("Add passkey aborts a sign-in page's autofill request left behind", async () => {
    wa = installWebAuthn({ autofill: true });
    field();
    void passkeySignIn({ autofill: true }).catch(() => undefined);
    await vi.waitFor(() => expect(conditionalCalls()).toHaveLength(1));
    const api = {
      passkeyRegisterOptions: async () => ({ options: { publicKey: CREATE_OPTIONS } }),
      passkeyRegisterVerify: async () => ({ passkey: { id: "cred_new", name: "iPad", created_at: "2026-11-05T00:00:00Z" } }),
    };
    await expect(addPasskey(api, "iPad")).resolves.toMatchObject({ id: "cred_new" });
    expect((conditionalCalls()[0][0] as CredentialRequestOptions).signal?.aborted).toBe(true);
    expect(wa.create).toHaveBeenCalledTimes(1);
  });

  it("a sign-in prompt that never finishes ends after 60 s with words to show", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wa = installWebAuthn();
    wa.get.mockImplementation(() => new Promise(() => {}));
    const signIn = passkeySignIn().catch((e: unknown) => e);
    await vi.waitFor(() => expect(wa!.get).toHaveBeenCalled());
    // our own cap reaches the browser too
    expect((wa.get.mock.calls[0][0] as { publicKey?: { timeout?: number } }).publicKey?.timeout).toBe(CEREMONY_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(CEREMONY_TIMEOUT_MS + 1);
    expect(await signIn).toMatchObject({ code: "timeout", message: DIDNT_FINISH, cancelled: false });
    expect(DIDNT_FINISH).toBe("That didn't finish. Try again.");
  });

  it("an Add passkey prompt that never finishes ends after 60 s too", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wa = installWebAuthn();
    wa.create.mockImplementation(() => new Promise(() => {}));
    const api = {
      passkeyRegisterOptions: async () => ({ options: { publicKey: CREATE_OPTIONS } }),
      passkeyRegisterVerify: vi.fn(),
    };
    const add = addPasskey(api, "iPad").catch((e: unknown) => e);
    await vi.waitFor(() => expect(wa!.create).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(CEREMONY_TIMEOUT_MS + 1);
    expect(await add).toMatchObject({ code: "timeout", message: DIDNT_FINISH, cancelled: false });
    expect(api.passkeyRegisterVerify).not.toHaveBeenCalled();
  });
});

const CREATE_OPTIONS = {
  challenge: "Y2hhbGxlbmdl",
  rp: { id: "localhost", name: "Spatial Video Studio" },
  user: { id: "dXNlcg", name: "dev@example.com", displayName: "Dev" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  timeout: 300000,
};
