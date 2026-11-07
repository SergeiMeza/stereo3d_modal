/**
 * Gateway 00155: a plan support offered to move here (RP-05), Accept with
 * a fresh sign-in, the gateway's refusals; restored plans refusing resume
 * (409 not_renewable); and a delete's plan credit never offered as a
 * refund.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import AccountScreen from "@/components/auth/AccountScreen";
import { ReauthSheet } from "@/components/auth/ReauthSheet";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { PlanCard } from "./PlanCard";
import { PlanMoveOffers } from "./PlanMoveOffers";
import { MOVE_EXPIRED } from "./planMoveAtoms";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/account/billing",
  useSearchParams: () => new URLSearchParams(),
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function offer(extra: { blocker?: string; expired?: boolean } = {}): void {
  mockDb.planMoves.push({
    id: "mv_1",
    plan: "studio",
    plan_id: "studio",
    ends_at: "2027-03-01T00:00:00Z",
    from: ["google.com"],
    moves: ["plan", "app_access", "current_usage"],
    stays: ["usage_already_used", "balance", "admin_grants", "past_runs_and_files"],
    carry_cents: 42000,
    expires_at: "2026-11-13T00:00:00Z",
    ...extra,
  });
}

function renderOffers(): void {
  render(
    <AuthProvider>
      <BillingProvider>
        <PlanMoveOffers />
        <PlanCard />
        <ReauthSheet />
      </BillingProvider>
    </AuthProvider>,
  );
}

describe("Support moved your plan here", () => {
  it("says what moves and until when; Accept moves it, ending on that date without a renewal", async () => {
    offer();
    renderOffers();
    const card = await screen.findByTestId("plan-move-mv_1");
    expect(card.textContent).toContain("Support moved your Studio plan here. Accept it?");
    expect(card.textContent).toContain("Valid until 1 Mar 2027.");
    expect(card.textContent).toContain("This month's unused usage ($420.00)");
    expect(card.textContent).toContain("Anything support gave the old account");
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.getByTestId("plan-move-mv_1").textContent).toBe("Your Studio plan is here."));
    const ending = await screen.findByTestId("scheduled-change");
    expect(ending.textContent).toContain("Your Studio stays on until Mar 1, 2027.");
    expect(within(ending).queryByRole("button", { name: /^Keep/ })).toBeNull();
  });

  it("a 409 shows the gateway's words and the offer stays", async () => {
    offer({ blocker: "target_has_plan" });
    renderOffers();
    const card = await screen.findByTestId("plan-move-mv_1");
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    expect((await within(card).findByRole("alert")).textContent).toBe("Your account has a plan of its own. Contact support.");
    expect(within(card).getByRole("button", { name: "Accept" })).toBeTruthy();
  });

  it("410 move_expired: This offer expired. Contact support.", async () => {
    offer({ expired: true });
    renderOffers();
    const card = await screen.findByTestId("plan-move-mv_1");
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toContain(MOVE_EXPIRED);
    expect(within(alert).getByRole("link", { name: "Contact support" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("Accept needs a fresh sign-in: Confirm it's you, then it moves", async () => {
    offer();
    let n = 0;
    server.use(
      http.post(`${GATEWAY}/v1/support/plan-moves/mv_1/accept`, () => {
        n += 1;
        return n === 1
          ? HttpResponse.json({ success: false, error: "reauth_required", message: "sign in again", details: { max_age_s: 300, method: "firebase" } }, { status: 401 })
          : undefined;
      }),
    );
    renderOffers();
    fireEvent.click(within(await screen.findByTestId("plan-move-mv_1")).getByRole("button", { name: "Accept" }));
    const sheet = await screen.findByTestId("reauth-sheet");
    fireEvent.click(within(sheet).getByRole("button", { name: "Send a code to dev@example.com" }));
    fireEvent.change(await within(sheet).findByLabelText("Sign-in code"), { target: { value: "123456" } });
    await waitFor(() => expect(screen.getByTestId("plan-move-mv_1").textContent).toBe("Your Studio plan is here."));
    expect(n).toBe(2);
  });
});

describe("restored and moved plans (gateway 00155)", () => {
  it("a resume refused with 409 not_renewable shows its words", async () => {
    mockDb.billing.plan = {
      plan: "business", name: "Business", status: "active", active: true, monthly_cents: 29900, credit_cents: 40000,
      credit_left_cents: 40000, cancel_at_period_end: true, current_period_end: "2026-12-05T12:00:00Z", interval: "month", price_cents: 29900,
    };
    server.use(
      http.post(`${GATEWAY}/v1/billing/plan/cancel`, () =>
        HttpResponse.json({ success: false, error: "not_renewable", message: "This plan was moved here and runs to its end." }, { status: 409 }),
      ),
    );
    renderOffers();
    const ending = await screen.findByTestId("scheduled-change");
    fireEvent.click(within(ending).getByRole("button", { name: "Keep Business" }));
    expect(await within(ending).findByText("This plan was moved here and runs to its end.")).toBeTruthy();
  });
});

describe("deleting: plan credit is never a refund (gateway 00155)", () => {
  it("the balance-lost line counts only the cash balance", async () => {
    for (const c of mockDb.conversions.values()) if (["created", "paid", "processing"].includes(c.state)) c.state = "canceled";
    server.use(
      http.post(`${GATEWAY}/v1/account/delete`, () =>
        HttpResponse.json(
          { success: false, error: "balance_remaining", message: "refund first", details: { cents: 1250, plan_credit_cents: 40000 } },
          { status: 409 },
        ),
      ),
    );
    render(
      <AuthProvider>
        <BillingProvider>
          <AccountScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    fireEvent.change(await screen.findByLabelText(/Type DELETE/), { target: { value: "DELETE" } });
    const button = screen.getByRole("button", { name: "Delete account" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    // an older gateway's 409: the loss line counts only the cash balance
    const lost = await screen.findByTestId("delete-balance-lost");
    expect(lost.textContent).toContain("Your unspent balance of $12.50 will be lost");
    expect(lost.textContent).not.toContain("$400");
  });
});
