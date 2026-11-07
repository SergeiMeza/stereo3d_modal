/**
 * BL-34: sign-in on the relay route. A browser outside China mode whose
 * direct host can't be reached moves to the cn. host and signs in through
 * the gateway (email code), never through the Firebase SDK. Someone
 * signed in through the SDK when the route moves is told plainly that
 * they need to sign in again with their email.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MOCK_EMAIL_CODE, mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import type { AuthContextValue } from "@/lib/auth";

const fb = vi.hoisted(() => ({
  calls: 0,
  user: null as null | Record<string, unknown>,
}));
vi.mock("@/lib/firebase", () => {
  // the SDK's own onAuthStateChanged calls the auth object's method
  const auth = () => ({
    currentUser: fb.user,
    authStateReady: async () => {},
    onAuthStateChanged: (cb: (u: unknown) => void) => {
      cb(fb.user);
      return () => {};
    },
  });
  return {
    getFirebaseApp: async () => {
      fb.calls++;
      return {};
    },
    getFirebaseAuth: async () => {
      fb.calls++;
      return auth();
    },
    firebaseConfig: () => ({}),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/signin",
  useSearchParams: () => new URLSearchParams(),
}));

const BASE = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const CN_HOST = "cn.localhost";

const requestUrls: string[] = [];
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    requestUrls.push(request.url);
  });
});
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "firebase");
  vi.resetModules();
  window.localStorage.clear();
  requestUrls.length = 0;
  fb.calls = 0;
  fb.user = null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

/** /health: the direct host fails to connect once `release` resolves (or
 * at once); the cn. host answers. */
function healthHandlers(release: Promise<void> = Promise.resolve()) {
  const cn = new URL(BASE);
  cn.hostname = `cn.${cn.hostname}`;
  server.use(
    http.get(`${BASE}/health`, async () => {
      await release;
      return HttpResponse.error();
    }),
    http.get(`${cn.origin}/health`, () => HttpResponse.json({ status: "ok" })),
  );
}

async function renderAuth() {
  const region = await import("@/lib/region");
  region.resetGatewayRouteForTests({ enabled: () => true });
  const { AuthProvider, useAuth } = await import("@/lib/auth");
  const seen: AuthContextValue[] = [];
  function Probe() {
    const auth = useAuth();
    seen.push(auth);
    return <p data-testid="state">{auth.ready ? (auth.user?.email ?? "signed-out") : "loading"}</p>;
  }
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("state").textContent).not.toBe("loading"));
  return { latest: () => seen[seen.length - 1], region };
}

describe("sign-in on the relay route", () => {
  it("signs in by email code through the cn. host, without the SDK", async () => {
    healthHandlers();
    const { latest, region } = await renderAuth();
    await act(() => region.prepareGatewayRoute());
    await waitFor(() => expect(region.currentRegion()).toBe("cn"));
    fb.calls = 0;

    await act(async () => {
      await latest().sendEmailCode("dev@example.com");
    });
    await act(() => latest().signInWithEmailCode("dev@example.com", MOCK_EMAIL_CODE));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("dev@example.com"));

    const auth = requestUrls.filter((u) => u.includes("/v1/auth/"));
    expect(auth.length).toBeGreaterThanOrEqual(2);
    for (const u of auth) expect(new URL(u).hostname).toBe(CN_HOST);
    expect(fb.calls).toBe(0);
    await expect(latest().getToken()).resolves.toBe("mock-id-1");
  });

  it("a remembered relay starts the next page load in China mode", async () => {
    window.localStorage.setItem("s3d-gateway-route", JSON.stringify({ route: "cn_relay", directCheckedAt: Date.now() }));
    healthHandlers();
    const { region } = await renderAuth();
    expect(region.currentRegion()).toBe("cn");
    expect(screen.getByTestId("state").textContent).toBe("signed-out");
    expect(fb.calls).toBe(0);
  });

  it("someone signed in through the SDK is told to sign in again with their email", async () => {
    fb.user = { uid: "u1", email: "sdk@example.com", displayName: null, photoURL: null, providerData: [] };
    let release!: () => void;
    healthHandlers(new Promise<void>((r) => (release = r)));
    const { latest, region } = await renderAuth();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("sdk@example.com"));
    expect(latest().redirectError).toBeNull();

    release();
    await act(() => region.prepareGatewayRoute());
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("signed-out"));
    expect(latest().redirectError).toBe(
      "We couldn't keep you signed in on this network. Sign in again with your email.",
    );
  });

  it("a direct host that answers keeps the SDK sign-in, with no notice", async () => {
    fb.user = { uid: "u1", email: "sdk@example.com", displayName: null, photoURL: null, providerData: [] };
    server.use(http.get(`${BASE}/health`, () => HttpResponse.json({ status: "ok" })));
    const { latest, region } = await renderAuth();
    await act(() => region.prepareGatewayRoute());
    expect(region.currentRegion()).toBe("global");
    expect(screen.getByTestId("state").textContent).toBe("sdk@example.com");
    expect(latest().redirectError).toBeNull();
  });
});
