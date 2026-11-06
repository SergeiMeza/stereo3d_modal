/**
 * Restore Purchases, step 2 (gateway 00152): a deleted account's plan,
 * found by this account's own sign-ins first, then by an email and its
 * code; what moves and what stays; Confirm it's you on the move; the
 * refusals in plain words.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ReauthSheet } from "@/components/auth/ReauthSheet";
import type { RestoreOffer } from "@/lib/api/client";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { PlanCard } from "./PlanCard";
import { APP_STORE_NOTE, RestorePurchases } from "./RestorePurchases";
import { HAS_OWN_PLAN, NOT_FOUND, RESTORED } from "./restoreMoveAtoms";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/account/billing",
  useSearchParams: () => new URLSearchParams(),
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  push.mockClear();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const OFFER: RestoreOffer = {
  offer_id: "off_1",
  plan: "studio",
  plan_id: "studio",
  ends_at: "2027-03-01T00:00:00Z",
  renews: false,
  from: ["email"],
  moves: ["plan", "app_access", "current_usage"],
  stays: ["usage_already_used", "balance", "app_store_purchases", "past_runs_and_files"],
  carry_cents: 42000,
};

function offer(where: { own?: boolean; emails?: string[]; elsewhere?: string[] }): void {
  mockDb.restoreOffers.push({ emails: where.emails ?? [], own: where.own ?? false, offer: OFFER, elsewhere: where.elsewhere });
}

function renderRestore(): void {
  render(
    <AuthProvider>
      <BillingProvider>
        <RestorePurchases />
        <ReauthSheet />
      </BillingProvider>
    </AuthProvider>,
  );
}

async function findButton(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Find purchases under another email" }));
}

async function byEmail(email: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText("The email you bought it with"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  expect((await screen.findByTestId("restore-code-sent")).textContent).toBe(
    `If we find purchases, we'll send a code to ${email}.`,
  );
  fireEvent.change(screen.getByLabelText("Sign-in code"), { target: { value: "123456" } });
}

describe("Find purchases under another email", () => {
  it("this account's own sign-ins find it first: what moves, what stays, Restore", async () => {
    offer({ own: true });
    renderRestore();
    expect(screen.getByText(APP_STORE_NOTE)).toBeTruthy();
    await findButton();
    const card = await screen.findByTestId("restore-offer-off_1");
    expect(card.textContent).toContain("Studio plan · valid until 1 Mar 2027");
    expect(card.textContent).not.toContain("renews");
    expect(card.textContent).toContain("Your plan, until that date");
    expect(card.textContent).toContain("This month's unused usage ($420.00)");
    expect(card.textContent).toContain("App Store purchases");
    fireEvent.click(within(card).getByRole("button", { name: "Restore Studio here" }));
    expect((await screen.findByTestId("restore-move-done")).textContent).toBe(RESTORED);
    expect(mockDb.billing.plan?.plan).toBe("studio");
    // Plan & billing: ending on that date, no renewal offered
    render(
      <AuthProvider>
        <BillingProvider>
          <PlanCard />
        </BillingProvider>
      </AuthProvider>,
    );
    const ending = await screen.findByTestId("scheduled-change");
    expect(ending.textContent).toContain("Your Studio stays on until Mar 1, 2027.");
    expect(within(ending).queryByRole("button", { name: /^Keep/ })).toBeNull();
  });

  it("otherwise an email and its code find it", async () => {
    offer({ emails: ["old@studio.example"] });
    renderRestore();
    await findButton();
    await byEmail("old@studio.example");
    expect(await screen.findByTestId("restore-offer-off_1")).toBeTruthy();
  });

  it("nothing under that email: We didn't find any purchases", async () => {
    renderRestore();
    await findButton();
    await byEmail("nobody@x.example");
    expect((await screen.findByTestId("restore-move-none")).textContent).toBe(NOT_FOUND);
  });

  it("this account has its own plan: Contact support", async () => {
    offer({ own: true });
    mockDb.billing.plan = {
      plan: "business", name: "Business", status: "active", active: true, monthly_cents: 29900, credit_cents: 40000,
      credit_left_cents: 40000, cancel_at_period_end: false, current_period_end: "2026-12-05T12:00:00Z", interval: "month", price_cents: 29900,
    };
    renderRestore();
    await findButton();
    fireEvent.click(within(await screen.findByTestId("restore-offer-off_1")).getByRole("button", { name: "Restore Studio here" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(HAS_OWN_PLAN);
    expect(within(alert).getByRole("link", { name: "Contact support" }).getAttribute("href")).toMatch(/^mailto:/);
  });

  it("restored on another account: offers to sign in to that one", async () => {
    offer({ emails: ["old@studio.example"], elsewhere: ["apple.com"] });
    renderRestore();
    await findButton();
    await byEmail("old@studio.example");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That plan was restored on another account.");
    expect(alert.textContent).toContain("(It signs in with Apple.)");
    fireEvent.click(within(alert).getByRole("button", { name: "Sign in to that account" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/signin?next=%2Faccount%2Fbilling"));
  });

  it("the move needs a fresh sign-in: Confirm it's you, then it's restored", async () => {
    offer({ own: true });
    let n = 0;
    server.use(
      http.post(`${GATEWAY}/v1/billing/restore/move`, () => {
        n += 1;
        return n === 1
          ? HttpResponse.json({ success: false, error: "reauth_required", message: "sign in again", details: { max_age_s: 300, method: "firebase" } }, { status: 401 })
          : undefined;
      }),
    );
    renderRestore();
    await findButton();
    fireEvent.click(within(await screen.findByTestId("restore-offer-off_1")).getByRole("button", { name: "Restore Studio here" }));
    const sheet = await screen.findByTestId("reauth-sheet");
    fireEvent.click(within(sheet).getByRole("button", { name: "Send a code to dev@example.com" }));
    fireEvent.change(await within(sheet).findByLabelText("Sign-in code"), { target: { value: "123456" } });
    expect((await screen.findByTestId("restore-move-done")).textContent).toBe(RESTORED);
    expect(n).toBe(2);
  });
});
