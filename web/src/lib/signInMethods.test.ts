import { describe, expect, it } from "vitest";

import { canRemove, fromIdentities, signInMethods } from "@/lib/signInMethods";

const both = { apple: true, google: true };

describe("signInMethods", () => {
  it("lists email, then Apple and Google to add", () => {
    const m = signInMethods({ email: "a@example.com", providerIds: [] }, both);
    expect(m).toEqual([
      { id: "email", linked: true },
      { id: "apple.com", linked: false },
      { id: "google.com", linked: false },
    ]);
  });

  it("hides what isn't offered unless already linked; shows an old password", () => {
    const m = signInMethods(
      { email: "a@example.com", providerIds: ["google.com", "password"] },
      { apple: false, google: false },
    );
    expect(m.map((x) => x.id)).toEqual(["email", "google.com", "password"]);
  });

  it("doesn't count an Apple relay address as email", () => {
    const m = signInMethods(
      { email: "abc@privaterelay.appleid.com", providerIds: ["apple.com"] },
      both,
    );
    expect(m.map((x) => x.id)).toEqual(["apple.com", "google.com"]);
    // Apple is the only way in: it stays
    expect(canRemove(m, "apple.com")).toBe(false);
  });
});

describe("canRemove", () => {
  it("never the email, never the last way in", () => {
    const withEmail = signInMethods({ email: "a@example.com", providerIds: ["apple.com"] }, both);
    expect(canRemove(withEmail, "email")).toBe(false);
    expect(canRemove(withEmail, "apple.com")).toBe(true);
    expect(canRemove(withEmail, "google.com")).toBe(false); // not linked
    const appleAndGoogle = signInMethods(
      { email: "x@privaterelay.appleid.com", providerIds: ["apple.com", "google.com"] },
      both,
    );
    expect(canRemove(appleAndGoogle, "apple.com")).toBe(true);
    expect(canRemove(appleAndGoogle, "google.com")).toBe(true);
  });
});

describe("EM-02: the gateway's identities", () => {
  it("maps providers and the password; passkeys keep the last method removable", () => {
    const view = fromIdentities({ providers: ["apple.com", "email"], email: "", password: true });
    expect(view).toEqual({ email: null, providerIds: ["apple.com", "password"] });
    const m = signInMethods(view, { apple: true, google: true });
    expect(canRemove(m, "apple.com")).toBe(false);
    expect(canRemove(m, "apple.com", 1)).toBe(true);
    expect(canRemove(m, "password")).toBe(true);
  });
});
