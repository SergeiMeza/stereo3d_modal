/**
 * China mode auth: the AuthProvider in live ("firebase") mode with the
 * s3d_region=cn cookie signs in through the gateway's /v1/auth/* routes
 * (mock handlers), keeps the session in localStorage, refreshes the ID
 * token before it expires, signs out, and never touches the Firebase SDK.
 *
 * AUTH_MODE is read when lib/auth loads, so each test stubs the env and
 * imports fresh modules.
 */

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { mockAuth, mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import type { AuthContextValue } from "@/lib/auth";

const firebaseCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/firebase", () => {
  // Counts calls; never settles, so the global-mode test can observe the
  // SDK being reached without a real Firebase.
  const touched = () => {
    firebaseCalls.count++;
    return new Promise(() => {});
  };
  return {
    getFirebaseApp: touched,
    getFirebaseAuth: touched,
    getFirebaseAnalytics: touched,
    firebaseConfig: () => ({}),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/signin",
  useSearchParams: () => new URLSearchParams(),
}));

const SESSION_KEY = "s3d-auth-session";

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
  document.cookie = "s3d_region=cn; Path=/";
  window.localStorage.clear();
  requestUrls.length = 0;
  firebaseCalls.count = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  document.cookie = "s3d_region=; Path=/; Max-Age=0";
  window.localStorage.clear();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

/** Render the provider with a probe that exposes the live context. */
async function renderAuth() {
  const { AuthProvider, useAuth } = await import("@/lib/auth");
  const seen: AuthContextValue[] = [];
  function Probe() {
    const auth = useAuth();
    seen.push(auth);
    return (
      <p data-testid="state">
        {auth.ready ? (auth.user?.email ?? "signed-out") : "loading"}
      </p>
    );
  }
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  const latest = () => seen[seen.length - 1];
  await waitFor(() => expect(screen.getByTestId("state").textContent).not.toBe("loading"));
  return { latest, seen };
}

function storedSession(): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(SESSION_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

describe("gateway auth provider (China mode)", () => {
  it("signs in by email through the cn gateway and keeps the session", async () => {
    const { latest, seen } = await renderAuth();
    expect(screen.getByTestId("state").textContent).toBe("signed-out");
    const tokenBefore = latest().getToken;

    await act(() => latest().signInWithEmail("dev@example.com", "password"));

    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("dev@example.com"),
    );
    expect(latest().user).toMatchObject({
      uid: "dev-user",
      displayName: "Dev User",
      providerIds: ["password"],
    });
    expect(storedSession()).toMatchObject({
      uid: "dev-user",
      idToken: "mock-id-1",
      refreshToken: "mock-refresh-1",
    });
    await expect(latest().getToken()).resolves.toBe("mock-id-1");

    // getToken never changes identity: useGateway memoizes on it.
    expect(new Set(seen.map((s) => s.getToken)).size).toBe(1);
    expect(latest().getToken).toBe(tokenBefore);

    const signin = requestUrls.find((u) => u.endsWith("/v1/auth/signin"));
    expect(signin).toBeDefined();
    expect(new URL(signin!).hostname.startsWith("cn.")).toBe(true);
    expect(firebaseCalls.count).toBe(0);
  });

  it("surfaces the gateway's errors as the usual friendly copy", async () => {
    const { latest } = await renderAuth();
    await expect(
      latest().signInWithEmail("dev@example.com", "wrong"),
    ).rejects.toThrow("Incorrect email or password.");
    await expect(
      latest().signUpWithEmail("dev@example.com", "whatever"),
    ).rejects.toThrow("An account with that email already exists");
    await expect(latest().signInWithGoogle()).rejects.toThrow(
      "Sign in with your email.",
    );
    expect(firebaseCalls.count).toBe(0);
  });

  it("creates an account and sends a reset email", async () => {
    const { latest } = await renderAuth();
    await act(() => latest().signUpWithEmail("new@example.com", "secret1"));
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("new@example.com"),
    );
    await act(() => latest().resetPassword("new@example.com"));
    expect(mockAuth.resets).toEqual(["new@example.com"]);
  });

  it("restores a stored session and refreshes the ID token before it expires", async () => {
    mockAuth.refreshTokens.set("stored-refresh", "dev-user");
    window.localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        uid: "dev-user",
        email: "dev@example.com",
        displayName: "Dev User",
        idToken: "old-id",
        refreshToken: "stored-refresh",
        expiresAt: Date.now() + 60_000, // inside the 5-minute margin
      }),
    );
    const { latest } = await renderAuth();
    expect(screen.getByTestId("state").textContent).toBe("dev@example.com");

    // Two callers at once share one refresh.
    const [a, b] = await Promise.all([latest().getToken(), latest().getToken()]);
    expect(a).toBe("mock-id-1");
    expect(b).toBe("mock-id-1");
    expect(requestUrls.filter((u) => u.endsWith("/v1/auth/refresh"))).toHaveLength(1);

    const stored = storedSession()!;
    expect(stored.idToken).toBe("mock-id-1");
    expect(stored.expiresAt as number).toBeGreaterThan(Date.now() + 50 * 60_000);

    // Fresh now: no further refresh.
    await expect(latest().getToken()).resolves.toBe("mock-id-1");
    expect(requestUrls.filter((u) => u.endsWith("/v1/auth/refresh"))).toHaveLength(1);
  });

  it("refreshes on a timer a few minutes before expiry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockAuth.refreshTokens.set("stored-refresh", "dev-user");
    window.localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        uid: "dev-user",
        email: "dev@example.com",
        displayName: null,
        idToken: "old-id",
        refreshToken: "stored-refresh",
        expiresAt: Date.now() + 10 * 60_000,
      }),
    );
    await renderAuth();
    expect(requestUrls.some((u) => u.endsWith("/v1/auth/refresh"))).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
    });
    await waitFor(() => expect(storedSession()?.idToken).toBe("mock-id-1"));
  });

  it("signs out when the gateway refuses the refresh token", async () => {
    window.localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        uid: "dev-user",
        email: "dev@example.com",
        displayName: null,
        idToken: "old-id",
        refreshToken: "revoked",
        expiresAt: Date.now() - 1000,
      }),
    );
    const { latest } = await renderAuth();
    await expect(latest().getToken()).rejects.toThrow("You are signed out");
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("signed-out"),
    );
    expect(storedSession()).toBeNull();
  });

  it("signs out locally and updates the display name", async () => {
    const { latest } = await renderAuth();
    await act(() => latest().signInWithEmail("dev@example.com", "password"));
    await act(() => latest().updateDisplayName("Renamed"));
    await waitFor(() => expect(latest().user?.displayName).toBe("Renamed"));
    expect(storedSession()?.displayName).toBe("Renamed");

    await act(() => latest().signOutUser());
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("signed-out"),
    );
    expect(storedSession()).toBeNull();
    await expect(latest().getToken()).rejects.toThrow("You are signed out");
    expect(firebaseCalls.count).toBe(0);
  });

  it("hides the Google button on the sign-in screen", async () => {
    const { AuthProvider } = await import("@/lib/auth");
    const { default: SignInScreen } = await import(
      "@/components/auth/SignInScreen"
    );
    render(
      <AuthProvider>
        <SignInScreen />
      </AuthProvider>,
    );
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(screen.queryByText(/google/i)).toBeNull();
  });
});

describe("outside China", () => {
  it("live mode still uses the Firebase SDK and shows Google", async () => {
    document.cookie = "s3d_region=; Path=/; Max-Age=0";
    const { AuthProvider } = await import("@/lib/auth");
    const { default: SignInScreen } = await import(
      "@/components/auth/SignInScreen"
    );
    render(
      <AuthProvider>
        <SignInScreen />
      </AuthProvider>,
    );
    expect(
      await screen.findByRole("button", { name: "Continue with Google" }),
    ).toBeTruthy();
    await waitFor(() => expect(firebaseCalls.count).toBeGreaterThan(0));
    expect(requestUrls.some((u) => u.includes("/v1/auth/"))).toBe(false);
  });
});
