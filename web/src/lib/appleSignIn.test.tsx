/**
 * Sign in with Apple through Apple's JS (owner 2026-11-05), with a
 * stand-in AppleID and auth SDK: success, cancel, error, account exists →
 * the pending link, Add Apple from the account page, the script fallback;
 * and the redirect fallback's settle (visible outcomes, read without an
 * intent when a redirect is pending) and the ?authdebug=1 panel.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthDebugPanel } from "@/components/auth/AuthDebugPanel";
import {
  APPLE_CLIENT_ID,
  APPLE_JS_URL,
  AppleCancelled,
  AppleJsUnavailable,
  appleAuthorize,
  resetAppleJsForTests,
  sha256Hex,
  type AppleIDAuth,
} from "@/lib/appleJs";
import { runAppleFlow, type AppleAuthApi } from "@/lib/appleSignIn";
import {
  authDebugAtom,
  readIntent,
  REDIRECT_KEY,
  redirectPending,
  settleRedirect,
} from "@/lib/authRedirect";
import { appStore } from "@/lib/state/stores";

type SignInAnswer = Awaited<ReturnType<AppleIDAuth["signIn"]>>;

/** A stand-in AppleID: records init, answers signIn as told. */
function fakeApple(answer: (state: string) => Promise<SignInAnswer>) {
  const inits: Parameters<AppleIDAuth["init"]>[0][] = [];
  window.AppleID = {
    auth: {
      init: (c) => inits.push(c),
      signIn: () => answer(inits[inits.length - 1].state),
    },
  };
  return inits;
}

beforeEach(() => {
  resetAppleJsForTests();
  delete window.AppleID;
});
afterEach(() => {
  cleanup();
  delete window.AppleID;
  document.querySelectorAll("script[data-apple-js]").forEach((s) => s.remove());
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("Apple's JS popup", () => {
  it("inits with the Services ID, /signin, a state and the SHA-256 of the nonce, and returns the token", async () => {
    const inits = fakeApple(async (state) => ({
      authorization: { id_token: "eyJ.apple.token", code: "c1", state },
      user: { email: "a@example.com", name: { firstName: "Aiko", lastName: "Tanaka" } },
    }));
    const a = await appleAuthorize();
    expect(inits).toHaveLength(1);
    const c = inits[0];
    expect(c.clientId).toBe(APPLE_CLIENT_ID);
    expect(c.clientId).toBe("com.oliver-ai.spatial-photo-studio.web");
    expect(c.scope).toBe("name email");
    expect(c.redirectURI).toBe(`${window.location.origin}/signin`);
    expect(c.usePopup).toBe(true);
    expect(c.state).toMatch(/^[0-9a-f]{32}$/);
    expect(a.rawNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(c.nonce).toBe(await sha256Hex(a.rawNonce));
    expect(a).toMatchObject({ idToken: "eyJ.apple.token", name: "Aiko Tanaka" });
  });

  it("refuses an answer whose state isn't ours", async () => {
    fakeApple(async () => ({ authorization: { id_token: "t", state: "someone-else" } }));
    await expect(appleAuthorize()).rejects.toThrow("Sign in with Apple didn't finish. Try again.");
  });

  it("a closed window is a quiet cancel; a blocked one says what to do", async () => {
    fakeApple(() => Promise.reject({ error: "popup_closed_by_user" }));
    await expect(appleAuthorize()).rejects.toBeInstanceOf(AppleCancelled);
    resetAppleJsForTests();
    fakeApple(() => Promise.reject({ error: "popup_blocked_by_browser" }));
    await expect(appleAuthorize()).rejects.toThrow(/blocked the Apple window/);
  });

  it("a script that won't load is AppleJsUnavailable (the redirect fallback)", async () => {
    const p = appleAuthorize();
    const s = document.querySelector<HTMLScriptElement>("script[data-apple-js]");
    expect(s?.src).toBe(APPLE_JS_URL);
    s?.dispatchEvent(new Event("error"));
    await expect(p).rejects.toBeInstanceOf(AppleJsUnavailable);
  });
});

interface FakeUser {
  uid: string;
  displayName: string | null;
}
interface FakeResult {
  user: FakeUser;
}

function fakeApi(over: Partial<AppleAuthApi<FakeUser, FakeResult>> = {}) {
  const calls = {
    signIn: vi.fn(async (cred: unknown) => ({ user: { uid: "u_apple_1", displayName: null }, cred }) as FakeResult),
    link: vi.fn(async () => ({ user: { uid: "u_web_1", displayName: "Ken" } }) as FakeResult),
    name: vi.fn(async () => undefined),
    settled: vi.fn(),
  };
  const api: AppleAuthApi<FakeUser, FakeResult> = {
    credential: (a) => ({ providerId: "apple.com", idToken: a.idToken, rawNonce: a.rawNonce }),
    signInWithCredential: calls.signIn,
    linkWithCredential: calls.link,
    updateDisplayName: calls.name,
    settled: calls.settled,
    ...over,
  };
  return { api, calls };
}

const answer = { idToken: "eyJ.apple", rawNonce: "n0nce", name: "Aiko Tanaka" };

describe("the Apple flow", () => {
  it("success: signs in with the apple.com credential, fills an empty name, tracks success", async () => {
    const { api, calls } = fakeApi();
    const track = vi.fn();
    const r = await runAppleFlow("signin", api, { capturePending: async () => null, track, authorize: async () => answer });
    expect(r).toEqual({ kind: "done" });
    expect(calls.signIn).toHaveBeenCalledWith({ providerId: "apple.com", idToken: "eyJ.apple", rawNonce: "n0nce" });
    expect(calls.name).toHaveBeenCalledWith({ uid: "u_apple_1", displayName: null }, "Aiko Tanaka");
    expect(calls.settled).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ uid: "u_apple_1" }) }), "signin");
    expect(track.mock.calls).toEqual([["apple_auth", { op: "signin", outcome: "success" }]]);
  });

  it("keeps a display name that's already there", async () => {
    const { api, calls } = fakeApi({
      signInWithCredential: async () => ({ user: { uid: "u2", displayName: "Kenji" } }),
    });
    await runAppleFlow("signin", api, { capturePending: async () => null, track: vi.fn(), authorize: async () => answer });
    expect(calls.name).not.toHaveBeenCalled();
  });

  it("cancel: nothing signs in, nothing is thrown", async () => {
    const { api, calls } = fakeApi();
    const track = vi.fn();
    const r = await runAppleFlow("signin", api, {
      capturePending: async () => null,
      track,
      authorize: () => Promise.reject(new AppleCancelled()),
    });
    expect(r).toEqual({ kind: "cancelled" });
    expect(calls.signIn).not.toHaveBeenCalled();
    expect(track.mock.calls).toEqual([["apple_auth", { op: "signin", outcome: "cancel" }]]);
  });

  it("error: thrown for the screen to show, tracked with its code", async () => {
    const { api } = fakeApi({
      signInWithCredential: () => Promise.reject(Object.assign(new Error("Invalid nonce."), { code: "auth/invalid-credential" })),
    });
    const track = vi.fn();
    await expect(
      runAppleFlow("signin", api, { capturePending: async () => null, track, authorize: async () => answer }),
    ).rejects.toThrow("Invalid nonce.");
    expect(track.mock.calls).toEqual([["apple_auth", { op: "signin", outcome: "error", code: "auth/invalid-credential" }]]);
  });

  it("account exists: the pending link, never silent", async () => {
    const refusal = Object.assign(new Error("exists"), { code: "auth/account-exists-with-different-credential" });
    const { api, calls } = fakeApi({ signInWithCredential: () => Promise.reject(refusal) });
    const capturePending = vi.fn(async (e: unknown) =>
      e === refusal ? { email: "aiko@example.com", providerId: "apple.com" as const } : null,
    );
    const track = vi.fn();
    const r = await runAppleFlow("signin", api, { capturePending, track, authorize: async () => answer });
    expect(r).toEqual({ kind: "pending", pending: { email: "aiko@example.com", providerId: "apple.com" } });
    expect(calls.settled).not.toHaveBeenCalled();
    expect(track.mock.calls).toEqual([["apple_auth", { op: "signin", outcome: "account_exists" }]]);
  });

  it("Add Apple on the account page links the credential to the signed-in user", async () => {
    const { api, calls } = fakeApi();
    const track = vi.fn();
    const r = await runAppleFlow("link", api, { capturePending: async () => null, track, authorize: async () => answer });
    expect(r).toEqual({ kind: "done" });
    expect(calls.link).toHaveBeenCalledWith({ providerId: "apple.com", idToken: "eyJ.apple", rawNonce: "n0nce" });
    expect(calls.signIn).not.toHaveBeenCalled();
    expect(calls.name).not.toHaveBeenCalled();
    expect(calls.settled).toHaveBeenCalledWith(expect.anything(), "link");
    expect(track.mock.calls).toEqual([["apple_auth", { op: "link", outcome: "success" }]]);
  });

  it("no script: the fallback, with no sign-in tried", async () => {
    const { api, calls } = fakeApi();
    const track = vi.fn();
    const r = await runAppleFlow("signin", api, {
      capturePending: async () => null,
      track,
      authorize: () => Promise.reject(new AppleJsUnavailable()),
    });
    expect(r).toEqual({ kind: "fallback" });
    expect(calls.signIn).not.toHaveBeenCalled();
    expect(track.mock.calls).toEqual([["apple_auth", { op: "signin", outcome: "fallback" }]]);
  });
});

describe("the redirect fallback's settle (owner bug 2026-11-05)", () => {
  const user = { uid: "abcdef123456", providerData: [{ providerId: "apple.com" }] };

  it("an intent that comes back empty with nobody signed in says so", async () => {
    const o = await settleRedirect({
      intent: { op: "signin", providerId: "apple.com" },
      pending: false,
      getRedirectResult: async () => null,
      currentUser: async () => null,
    });
    expect(o).toEqual({ kind: "unfinished", message: "Sign-in with Apple didn't finish. Try again." });
  });

  it("an empty answer with the user already signed in is fine", async () => {
    const o = await settleRedirect({
      intent: { op: "signin", providerId: "apple.com" },
      pending: false,
      getRedirectResult: async () => null,
      currentUser: async () => user,
    });
    expect(o).toEqual({ kind: "none" });
  });

  it("a link that came back without Apple on the user says so", async () => {
    const o = await settleRedirect({
      intent: { op: "link", providerId: "apple.com" },
      pending: false,
      getRedirectResult: async () => null,
      currentUser: async () => ({ uid: "u", providerData: [{ providerId: "password" }] }),
    });
    expect(o).toEqual({ kind: "unfinished", message: "Connecting Apple didn't finish. Try again." });
  });

  it("reads the answer without an intent when a redirect is pending, and not otherwise", async () => {
    const getRedirectResult = vi.fn(async () => ({ user }));
    expect(
      await settleRedirect({ intent: null, pending: false, getRedirectResult, currentUser: async () => null }),
    ).toEqual({ kind: "skipped" });
    expect(getRedirectResult).not.toHaveBeenCalled();
    const o = await settleRedirect({ intent: null, pending: true, getRedirectResult, currentUser: async () => null });
    expect(o).toMatchObject({ kind: "user", user: { uid: "abcdef123456" } });
    // no intent and an empty answer: nothing to say
    expect(
      await settleRedirect({ intent: null, pending: true, getRedirectResult: async () => null, currentUser: async () => null }),
    ).toEqual({ kind: "none" });
  });

  it("an error comes back as one (the screen shows it, or the pending link takes it)", async () => {
    const e = Object.assign(new Error("nope"), { code: "auth/network-request-failed" });
    const o = await settleRedirect({
      intent: { op: "signin", providerId: "apple.com" },
      pending: false,
      getRedirectResult: () => Promise.reject(e),
      currentUser: async () => null,
    });
    expect(o).toEqual({ kind: "error", error: e });
  });

  it("a pending redirect shows in the SDK's sessionStorage key or the handler's URL", () => {
    expect(redirectPending(sessionStorage, "https://staging.stereo3d.studio/signin?next=%2Fprojects")).toBe(false);
    sessionStorage.setItem("firebase:pendingRedirect:AIzaKey:[DEFAULT]", '"true"');
    expect(redirectPending(sessionStorage, "https://staging.stereo3d.studio/signin")).toBe(true);
    sessionStorage.clear();
    expect(redirectPending(sessionStorage, "https://staging.stereo3d.studio/signin#authType=signInViaRedirect&eventId=1")).toBe(true);
  });

  it("reads the stored intent and ignores a malformed one", () => {
    sessionStorage.setItem(REDIRECT_KEY, JSON.stringify({ op: "signin", providerId: "apple.com" }));
    expect(readIntent(sessionStorage).intent).toEqual({ op: "signin", providerId: "apple.com" });
    sessionStorage.setItem(REDIRECT_KEY, "{oops");
    expect(readIntent(sessionStorage)).toEqual({ intent: null, raw: "{oops" });
  });
});

describe("?authdebug=1", () => {
  it("shows what the settle saw, with a uid prefix only, and nothing without the flag", () => {
    appStore.set(authDebugAtom, {
      intent: '{"op":"signin","providerId":"apple.com"}',
      pending: true,
      ran: true,
      outcome: "user abcdef…",
      currentUser: true,
      authDomain: "auth.stereo3d.studio",
      host: "staging.stereo3d.studio",
      at: "2026-11-05T10:00:00.000Z",
    });
    render(<AuthDebugPanel />);
    expect(screen.queryByTestId("auth-debug")).toBeNull();
    cleanup();
    window.history.replaceState({}, "", "/signin?authdebug=1");
    render(<AuthDebugPanel />);
    const panel = screen.getByTestId("auth-debug");
    expect(panel.textContent).toContain("user abcdef…");
    expect(panel.textContent).toContain("auth.stereo3d.studio");
    expect(panel.textContent).toContain("2026-11-05T10:00:00.000Z");
    expect(panel.textContent).not.toContain("abcdef123456");
  });
});
