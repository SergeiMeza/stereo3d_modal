/**
 * EM-02 (owner 2026-11-06): the account's sign-in methods through the
 * gateway (/v1/account/identities): the list, Add Apple (Apple's ID token
 * and raw nonce), Remove, the gateway's refusals, "Sign in to that
 * account", and an old sign-in asking "Confirm it's you" first.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ReauthSheet } from "@/components/auth/ReauthSheet";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { IdentityInUseError, linkAppleAtom } from "./identityAtoms";
import { SignInMethods } from "./SignInMethods";
import { appStore } from "@/lib/state/stores";

const apple = vi.hoisted(() => ({
  authorize: vi.fn(async () => ({ idToken: "eyJ.apple", rawNonce: "n0nce", name: null })),
}));
vi.mock("@/lib/appleJs", async (orig) => ({
  ...(await orig<typeof import("@/lib/appleJs")>()),
  appleAuthorize: apple.authorize,
  prepareApple: () => {},
}));
// mock mode doesn't offer Apple; these tests do (as the live site does)
vi.mock("@/lib/auth", async (orig) => {
  const real = await orig<typeof import("@/lib/auth")>();
  return { ...real, useAuth: () => ({ ...real.useAuth(), appleEnabled: true }) };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/account",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  apple.authorize.mockClear();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

function renderMethods(): void {
  render(
    <AuthProvider>
      <BillingProvider>
        <SignInMethods />
        <ReauthSheet />
      </BillingProvider>
    </AuthProvider>,
  );
}

function row(id: string): HTMLElement {
  return screen.getByTestId(`method-${id}`);
}

describe("Account → Sign in with (EM-02)", () => {
  it("lists what the gateway says, and Remove goes through DELETE", async () => {
    mockDb.identities = { providers: ["apple.com", "google.com", "email"], email: "dev@example.com", password: false };
    let deleted: string | null = null;
    server.events.on("request:start", ({ request }) => {
      if (request.method === "DELETE" && request.url.includes("/v1/account/identities/")) deleted = request.url;
    });
    renderMethods();
    await waitFor(() => expect(within(row("apple.com")).getByRole("button", { name: "Remove" })).toBeTruthy());
    expect(within(row("google.com")).getByRole("button", { name: "Remove" })).toBeTruthy();
    fireEvent.click(within(row("apple.com")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(row("apple.com")).getByRole("button", { name: "Add" })).toBeTruthy());
    expect(deleted).toMatch(/\/v1\/account\/identities\/apple\.com$/);
    expect(mockDb.identities.providers).toEqual(["google.com", "email"]);
    server.events.removeAllListeners();
  });

  it("Add Apple sends Apple's ID token and raw nonce to the gateway", async () => {
    let body: unknown = null;
    server.events.on("request:start", async ({ request }) => {
      if (request.url.endsWith("/v1/account/identities/link")) body = await request.clone().json();
    });
    renderMethods();
    fireEvent.click(await within(await screen.findByTestId("method-apple.com")).findByRole("button", { name: "Add" }));
    await waitFor(() => expect(within(row("apple.com")).getByRole("button", { name: "Remove" })).toBeTruthy());
    expect(body).toEqual({ provider: "apple.com", id_token: "eyJ.apple", nonce: "n0nce" });
    server.events.removeAllListeners();
  });

  it("an Apple ID of another account says so and offers to sign in to it", async () => {
    mockDb.identityInUse = ["apple.com", "email"];
    renderMethods();
    fireEvent.click(await within(await screen.findByTestId("method-apple.com")).findByRole("button", { name: "Add" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "That sign-in belongs to another account (it signs in with Apple or an email code).",
    );
    expect(within(alert).getByRole("button", { name: "Sign in to that account" })).toBeTruthy();
  });

  it("the gateway's refusal shows its words (last_method)", async () => {
    mockDb.identities = { providers: ["apple.com", "google.com", "email"], email: "dev@example.com", password: false };
    server.use(
      http.delete(/\/v1\/account\/identities\/google\.com$/, () =>
        HttpResponse.json(
          { success: false, error: "last_method", message: "That's your only way to sign in. Add another first." },
          { status: 409 },
        ),
      ),
    );
    renderMethods();
    await waitFor(() => expect(within(row("google.com")).getByRole("button", { name: "Remove" })).toBeTruthy());
    fireEvent.click(within(row("google.com")).getByRole("button", { name: "Remove" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That's your only way to sign in. Add another first.");
  });

  it("an old sign-in asks Confirm it's you, then removes", async () => {
    mockDb.identities = { providers: ["apple.com", "email"], email: "dev@example.com", password: false };
    let n = 0;
    server.use(
      http.delete(`${GATEWAY}/v1/account/identities/apple.com`, () => {
        n += 1;
        return n === 1
          ? HttpResponse.json({ success: false, error: "reauth_required", message: "sign in again", details: { max_age_s: 300, method: "firebase" } }, { status: 401 })
          : undefined;
      }),
    );
    renderMethods();
    await waitFor(() => expect(within(row("apple.com")).getByRole("button", { name: "Remove" })).toBeTruthy());
    fireEvent.click(within(row("apple.com")).getByRole("button", { name: "Remove" }));
    const sheet = await screen.findByTestId("reauth-sheet");
    fireEvent.click(within(sheet).getByRole("button", { name: "Send a code to dev@example.com" }));
    fireEvent.change(await within(sheet).findByLabelText("Sign-in code"), { target: { value: "123456" } });
    await waitFor(() => expect(within(row("apple.com")).getByRole("button", { name: "Add" })).toBeTruthy());
    expect(n).toBe(2);
  });

  it("Sign in to that account uses the same Apple answer (switches)", async () => {
    const signIn = vi.fn(async () => {});
    const client = {
      getIdentities: vi.fn(),
      unlinkIdentity: vi.fn(),
      linkIdentity: vi.fn(async () => {
        const { GatewayError } = await import("@/lib/api/client");
        throw new GatewayError("credential_in_use", "in use", 409, { providers: ["apple.com"] });
      }),
    };
    const e = await appStore
      .set(linkAppleAtom, { client: client as never, reloadUser: async () => {}, signInWithAppleToken: signIn })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(IdentityInUseError);
    await (e as IdentityInUseError).switchTo!();
    expect(signIn).toHaveBeenCalledWith("eyJ.apple", "n0nce");
  });
});
