/**
 * /account/billing?settle=1: the app's link after deleting the account
 * answered 402 balance_due. The Settle sheet opens once and the parameter
 * goes; nothing owed says so; signed out, sign-in comes back with it.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RequireAuth } from "@/components/auth/RequireAuth";
import { SettleProvider } from "@/components/pay/SettleSheet";
import { AuthProvider, authStateAtom } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { appStore } from "@/lib/state/stores";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { NOTHING_TO_PAY, SettleFromLink } from "./SettleFromLink";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/account/billing",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  replace.mockClear();
  server.resetHandlers();
  mockDb.reset();
  window.history.replaceState(null, "", "/");
});
afterAll(() => server.close());

function renderPage(): void {
  render(
    <AuthProvider>
      <BillingProvider>
        <SettleProvider>
          <RequireAuth>
            <SettleFromLink />
          </RequireAuth>
        </SettleProvider>
      </BillingProvider>
    </AuthProvider>,
  );
}

describe("/account/billing?settle=1", () => {
  it("opens the Settle sheet once for what's owed and drops the parameter", async () => {
    mockDb.billing.unpaid.push({ conversion_id: "m0cdeadbeef1", amount_cents: 333, currency: "usd", needs_action: false });
    window.history.replaceState(null, "", "/account/billing?settle=1");
    renderPage();
    expect(await screen.findByTestId("settle-sheet")).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(screen.queryByTestId("settle-nothing")).toBeNull();
  });

  it("the failed-payment mails' ?pay=1 opens it too (BUX-01)", async () => {
    mockDb.billing.unpaid.push({ conversion_id: "m0cdeadbeef1", amount_cents: 333, currency: "usd", needs_action: false });
    window.history.replaceState(null, "", "/account/billing?pay=1&utm_source=mail");
    renderPage();
    expect(await screen.findByTestId("settle-sheet")).toBeTruthy();
    expect(window.location.search).toBe("?utm_source=mail");
  });

  it("with nothing owed: Nothing to pay.", async () => {
    window.history.replaceState(null, "", "/account/billing?settle=1");
    renderPage();
    expect((await screen.findByTestId("settle-nothing")).textContent).toBe(NOTHING_TO_PAY);
    expect(screen.queryByTestId("settle-sheet")).toBeNull();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("without it, nothing opens", async () => {
    mockDb.billing.unpaid.push({ conversion_id: "m0cdeadbeef1", amount_cents: 333, currency: "usd", needs_action: false });
    window.history.replaceState(null, "", "/account/billing");
    renderPage();
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByTestId("settle-sheet")).toBeNull();
    expect(screen.queryByTestId("settle-nothing")).toBeNull();
  });

  it("signed out: sign in first, and come back with ?settle=1", async () => {
    appStore.set(authStateAtom, (a) => ({ ...a, user: null, ready: true }));
    window.history.replaceState(null, "", "/account/billing?settle=1");
    renderPage();
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`/signin?next=${encodeURIComponent("/account/billing?settle=1")}`),
    );
  });
});
