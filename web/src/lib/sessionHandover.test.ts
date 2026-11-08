/**
 * BL-34 gap 3: the SDK's sign-in becomes the gateway session through
 * /v1/auth/refresh, or things stay as they were.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mockAuth } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import type { HandoverDeps, HandoverUser } from "@/lib/sessionHandover";

vi.mock("@/lib/firebase", () => ({
  loadedFirebaseAuth: () => null,
  firebaseConfig: () => ({ apiKey: "test-key" }),
}));

const SESSION_KEY = "s3d-auth-session";
const SDK_KEY = "firebase:authUser:test-key:[DEFAULT]";
const USER: HandoverUser = { uid: "dev-user", email: "dev@example.com", displayName: "Dev User", refreshToken: "sdk-refresh" };

const refreshCalls: string[] = [];
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    if (request.url.endsWith("/v1/auth/refresh")) refreshCalls.push(request.url);
  });
});
beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  refreshCalls.length = 0;
  mockAuth.reset();
});
afterEach(() => {
  server.resetHandlers();
  window.localStorage.clear();
});
afterAll(() => server.close());

async function load() {
  const handover = await import("@/lib/sessionHandover");
  const gatewayAuth = await import("@/lib/gatewayAuth");
  return { ...handover, ...gatewayAuth };
}

function deps(user: HandoverUser | null) {
  const d = {
    signOuts: 0,
    firebaseUser: vi.fn(async () => user),
    signOutFirebase: vi.fn(async () => {
      d.signOuts++;
    }),
  };
  return d satisfies HandoverDeps & { signOuts: number };
}

describe("handOverFirebaseSession", () => {
  it("stores the refreshed session and signs the SDK out", async () => {
    mockAuth.refreshTokens.set("sdk-refresh", "dev-user");
    const { handOverFirebaseSession, gatewaySession } = await load();
    const d = deps(USER);
    await expect(handOverFirebaseSession(d)).resolves.toBe("adopted");
    expect(refreshCalls).toHaveLength(1);
    expect(gatewaySession()).toMatchObject({ uid: "dev-user", email: "dev@example.com", displayName: "Dev User" });
    expect(JSON.parse(window.localStorage.getItem(SESSION_KEY) ?? "null")).toMatchObject({ uid: "dev-user" });
    expect(d.signOuts).toBe(1);
  });

  it("a refused refresh stores nothing and leaves the SDK signed in", async () => {
    const { handOverFirebaseSession, gatewaySession } = await load();
    const d = deps({ ...USER, refreshToken: "revoked" });
    await expect(handOverFirebaseSession(d)).resolves.toBe("failed");
    expect(gatewaySession()).toBeNull();
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(d.signOuts).toBe(0);
  });

  it("a different account in the answer stores nothing", async () => {
    mockAuth.refreshTokens.set("sdk-refresh", "dev-user");
    const { handOverFirebaseSession, gatewaySession } = await load();
    const d = deps({ ...USER, uid: "someone-else" });
    await expect(handOverFirebaseSession(d)).resolves.toBe("failed");
    expect(gatewaySession()).toBeNull();
    expect(d.signOuts).toBe(0);
  });

  it("does nothing when a gateway session is already there", async () => {
    const existing = { uid: "gw", email: "gw@example.com", displayName: null, idToken: "id", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 };
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(existing));
    const { handOverFirebaseSession, gatewaySession } = await load();
    const d = deps(USER);
    await expect(handOverFirebaseSession(d)).resolves.toBe("kept");
    expect(d.firebaseUser).not.toHaveBeenCalled();
    expect(refreshCalls).toHaveLength(0);
    expect(gatewaySession()).toEqual(existing);
    expect(d.signOuts).toBe(0);
  });

  it("does nothing when nobody is signed in through the SDK", async () => {
    const { handOverFirebaseSession, gatewaySession } = await load();
    const d = deps(null);
    await expect(handOverFirebaseSession(d)).resolves.toBe("none");
    expect(refreshCalls).toHaveLength(0);
    expect(gatewaySession()).toBeNull();
    expect(d.signOuts).toBe(0);
  });

  it("reads and removes the SDK's stored user when the SDK isn't loaded", async () => {
    mockAuth.refreshTokens.set("sdk-refresh", "dev-user");
    window.localStorage.setItem(
      SDK_KEY,
      JSON.stringify({ uid: "dev-user", email: "dev@example.com", displayName: null, stsTokenManager: { refreshToken: "sdk-refresh", accessToken: "at" } }),
    );
    const { handOverFirebaseSession, gatewaySession } = await load();
    await expect(handOverFirebaseSession()).resolves.toBe("adopted");
    expect(gatewaySession()).toMatchObject({ uid: "dev-user", email: "dev@example.com" });
    expect(window.localStorage.getItem(SDK_KEY)).toBeNull();
  });
});

describe("parseStoredUser", () => {
  it("needs a uid and a refresh token", async () => {
    const { parseStoredUser } = await load();
    expect(parseStoredUser({ uid: "u", stsTokenManager: { refreshToken: "r" } })).toEqual({ uid: "u", email: null, displayName: null, refreshToken: "r" });
    expect(parseStoredUser({ uid: "u", stsTokenManager: {} })).toBeNull();
    expect(parseStoredUser({ stsTokenManager: { refreshToken: "r" } })).toBeNull();
    expect(parseStoredUser(null)).toBeNull();
  });
});
