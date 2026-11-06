/**
 * Owner 2026-11-06: "Sensitive operations require fresh sign ins." A 401
 * reauth_required opens the one shared "Confirm it's you" sheet and the
 * request is tried once more; closing the sheet changes nothing.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import AccountScreen from "@/components/auth/AccountScreen";
import { ReauthSheet } from "@/components/auth/ReauthSheet";
import { GatewayClient } from "@/lib/api/client";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { confirmItsYou, finishReauth, NOT_CONFIRMED, ReauthCancelledError } from "@/lib/reauth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/account",
  useSearchParams: () => new URLSearchParams(),
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  replace.mockClear();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const REAUTH = { success: false, error: "reauth_required", message: "sign in again", details: { max_age_s: 300 } };

/** The first `times` calls to a route answer 401 reauth_required. */
function reauthFirst(method: "post" | "delete", path: string, times = 1): { calls: () => number } {
  let n = 0;
  server.use(
    http[method](`${GATEWAY}${path}`, () => {
      n += 1;
      if (n <= times) return HttpResponse.json(REAUTH, { status: 401 });
      return undefined;
    }),
  );
  return { calls: () => n };
}

describe("the gateway client and reauth_required", () => {
  const client = (onReauthRequired: () => Promise<void>) =>
    new GatewayClient({ baseUrl: GATEWAY, getToken: async () => "mock-token", onReauthRequired });

  it.each([
    ["a payment method", "delete", "/v1/billing/methods/pm_1", (c: GatewayClient) => c.removeMethod("pm_1")],
    ["a plan change", "post", "/v1/plans/change", (c: GatewayClient) => c.changePlan("pay_per_video")],
    ["a passkey", "delete", "/v1/account/passkeys/cred_1", (c: GatewayClient) => c.removePasskey("cred_1")],
  ] as const)("removing %s: confirm it's you, then once more", async (_name, method, path, call) => {
    const route = reauthFirst(method, path);
    // the default handlers answer the retry (or refuse it: either way it was sent once more)
    const confirm = vi.fn(async () => {});
    await call(client(confirm)).catch(() => {});
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(route.calls()).toBe(2);
  });

  it("asks once only: a second reauth_required is the caller's error", async () => {
    const route = reauthFirst("post", "/v1/plans/change", 2);
    const confirm = vi.fn(async () => {});
    await expect(client(confirm).changePlan("pay_per_video")).rejects.toMatchObject({ code: "reauth_required" });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(route.calls()).toBe(2);
  });

  it("not confirmed: no retry, nothing changed", async () => {
    const route = reauthFirst("post", "/v1/plans/change");
    await expect(
      client(() => Promise.reject(new ReauthCancelledError())).changePlan("pay_per_video"),
    ).rejects.toThrow(NOT_CONFIRMED);
    expect(route.calls()).toBe(1);
  });

  it("requests at the same time share one sheet", async () => {
    const a = confirmItsYou();
    const b = confirmItsYou();
    expect(a).toBe(b);
    act(() => finishReauth(true));
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
  });
});

describe("Confirm it's you, on Account → Delete", () => {
  function renderAccount() {
    render(
      <AuthProvider>
        <BillingProvider>
          <AccountScreen />
          <ReauthSheet />
        </BillingProvider>
      </AuthProvider>,
    );
  }

  async function typeAndDelete(): Promise<void> {
    fireEvent.change(screen.getByLabelText(/Type DELETE/), { target: { value: "DELETE" } });
    const button = screen.getByRole("button", { name: "Delete account" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
  }

  function settleRuns(): void {
    for (const c of mockDb.conversions.values()) {
      if (["created", "paid", "processing"].includes(c.state)) c.state = "canceled";
    }
  }

  it("a code to the email confirms it, and the delete goes through", async () => {
    settleRuns();
    const route = reauthFirst("post", "/v1/account/delete");
    renderAccount();
    await typeAndDelete();
    const sheet = await screen.findByTestId("reauth-sheet");
    expect(within(sheet).getByText("Confirm it's you")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Send a code to dev@example.com" }));
    fireEvent.change(await within(sheet).findByLabelText("Sign-in code"), { target: { value: "123456" } });
    // gateway 00166: it says when the account goes, then signs out
    await screen.findByTestId("deletion-scheduled");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(route.calls()).toBe(2);
    expect(screen.queryByTestId("reauth-sheet")).toBeNull();
  });

  it("Cancel keeps the account and says nothing changed", async () => {
    settleRuns();
    const route = reauthFirst("post", "/v1/account/delete");
    renderAccount();
    await typeAndDelete();
    const sheet = await screen.findByTestId("reauth-sheet");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(NOT_CONFIRMED)).toBeTruthy();
    expect(route.calls()).toBe(1);
    expect(replace).not.toHaveBeenCalled();
  });
});
