import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { optionsOf, passkeySignIn } from "@/lib/passkeys";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import { installWebAuthn } from "@/test/webauthn";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
let wa: ReturnType<typeof installWebAuthn> | null = null;
afterEach(() => {
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
