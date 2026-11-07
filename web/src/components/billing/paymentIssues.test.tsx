/**
 * Owner 2026-11-07 (D): a plan's renewal past due and payments being
 * retried show on Billing and on the projects pages' banner, each with
 * Pay now to its pay page; the plan's benefits are never said to stop,
 * and auto-reload reads as paused while its reload is retried.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import AccountScreen from "@/components/auth/AccountScreen";
import { BalanceDialogsProvider } from "@/components/pay/BalanceDialogs";
import { SettleProvider } from "@/components/pay/SettleSheet";
import type { AccountPlan, PaymentRetry } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { makeTr } from "@/lib/i18n/t";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { BillingBanner } from "./BillingBanner";
import { BillingScreen } from "./BillingScreen";
import { paymentIssues } from "./PaymentIssues";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/account/billing",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const NEXT = "2026-11-09T09:00:00Z";

function pastDue(over: Partial<AccountPlan> = {}): void {
  mockDb.tierPricing = true;
  mockDb.billing.plan = {
    plan: "business",
    name: "Business",
    status: "past_due",
    active: true,
    monthly_cents: 29900,
    credit_cents: 40000,
    credit_left_cents: 40000,
    cancel_at_period_end: false,
    current_period_end: "2026-12-05T12:00:00Z",
    interval: "month",
    price_cents: 29900,
    past_due: true,
    payment_failed_at: "2026-11-07T09:00:00Z",
    next_payment_attempt_at: NEXT,
    action_required: false,
    amount_due_cents: 29900,
    pay_url: "https://stereo3d.studio/pay/tok_plan",
    ...over,
  };
}

function billing(): void {
  render(
    <AuthProvider>
      <BillingProvider>
        <BalanceDialogsProvider>
          <BillingScreen />
        </BalanceDialogsProvider>
      </BillingProvider>
    </AuthProvider>,
  );
}

function banner(): void {
  render(
    <AuthProvider>
      <BillingProvider>
        <BillingBanner />
      </BillingProvider>
    </AuthProvider>,
  );
}

describe("a plan past due", () => {
  it("Billing says so with Pay now, and never that the plan stopped", async () => {
    pastDue();
    billing();
    const issue = await screen.findByTestId("payment-issue-past_due");
    expect(issue.textContent).toContain("Your Business payment didn't go through. Pay now to keep your plan.");
    expect(within(issue).getByTestId("payment-issue-pay-past_due").getAttribute("href")).toBe("https://stereo3d.studio/pay/tok_plan");
    expect(document.body.textContent).not.toMatch(/stopped|paused your plan|lost access/i);
  });

  it("the projects pages' banner shows it too", async () => {
    pastDue();
    banner();
    expect((await screen.findByTestId("payment-issue-past_due")).textContent).toContain("Pay now to keep your plan.");
  });

  it("the Account page shows it too (owner 2026-11-07: people check their plan there)", async () => {
    pastDue();
    render(
      <AuthProvider>
        <BillingProvider>
          <AccountScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    const issue = await screen.findByTestId("payment-issue-past_due");
    expect(issue.textContent).toContain("Your Business payment didn't go through. Pay now to keep your plan.");
    expect(within(issue).getByTestId("payment-issue-pay-past_due").getAttribute("href")).toBe("https://stereo3d.studio/pay/tok_plan");
  });

  it("when the bank wants a confirmation, it says to confirm with the bank", async () => {
    pastDue({ action_required: true });
    banner();
    expect((await screen.findByTestId("payment-issue-past_due")).textContent).toContain(
      "Your Business payment didn't go through. Confirm your payment with your bank.",
    );
  });

  it("nothing without past_due", async () => {
    pastDue({ past_due: false });
    banner();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("payment-issue-past_due")).toBeNull();
  });
});

describe("what the account owes (QA 2026-11-07: it showed only inside the History row)", () => {
  function owe(cents: number): void {
    mockDb.billing.unpaid.push({ conversion_id: "cowed0000001", amount_cents: cents, currency: "usd", needs_action: false });
  }

  it("Billing: You have $3.75 to pay, and Pay now opens the settle sheet", async () => {
    owe(375);
    render(
      <AuthProvider>
        <BillingProvider>
          <SettleProvider>
            <BalanceDialogsProvider>
              <BillingScreen />
            </BalanceDialogsProvider>
          </SettleProvider>
        </BillingProvider>
      </AuthProvider>,
    );
    const issue = await screen.findByTestId("payment-issue-owed");
    expect(issue.textContent).toContain("You have $3.75 to pay. Your downloads come back as soon as it's paid.");
    fireEvent.click(within(issue).getByTestId("payment-issue-pay-owed"));
    expect(await screen.findByTestId("settle-sheet")).toBeTruthy();
  });

  it("the Account page and the projects pages' banner show it too", async () => {
    owe(375);
    render(
      <AuthProvider>
        <BillingProvider>
          <AccountScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    expect((await screen.findByTestId("payment-issue-owed")).textContent).toContain("You have $3.75 to pay.");
    cleanup();
    banner();
    expect((await screen.findByTestId("payment-issue-owed")).textContent).toContain("You have $3.75 to pay.");
  });

  it("nothing owed: nothing", async () => {
    banner();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("payment-issue-owed")).toBeNull();
  });
});

describe("payments being retried", () => {
  it("a pending auto-reload: when we'll try again, Pay now, and auto-reload paused", async () => {
    mockDb.billing.prepaid.auto_reload = { enabled: true, below_cents: 1000, add_cents: 2500 };
    mockDb.billing.balanceExtra = {
      auto_reload: {
        enabled: true,
        below_cents: 1000,
        add_cents: 2500,
        retry: { state: "pending", reason: "soft_decline", attempts: 1, max_attempts: 4, next_attempt_at: NEXT, amount_cents: 2500, pay_url: "/pay/tok_reload" },
      },
    };
    billing();
    const issue = await screen.findByTestId("payment-issue-reload_retry");
    expect(issue.textContent).toContain("A payment didn't go through. We'll try again on Nov 9.");
    expect(within(issue).getByTestId("payment-issue-pay-reload_retry").getAttribute("href")).toBe("/pay/tok_reload");
    expect((await screen.findByTestId("reload-paused")).textContent).toContain("Paused while we try the last reload again.");
  });

  it("final dues: Payment failed, Pay now", async () => {
    mockDb.billing.duesRetry = { state: "final", reason: "hard_decline", attempts: 4, max_attempts: 4, final_at: NEXT, amount_cents: 1200, pay_url: "/pay/tok_dues" };
    banner();
    const issue = await screen.findByTestId("payment-issue-dues_retry");
    expect(issue.textContent).toContain("Payment failed.");
    expect(within(issue).getByTestId("payment-issue-pay-dues_retry").textContent).toBe("Pay now");
  });

  it("no retry (null) shows nothing", () => {
    const t = makeTr("en", null);
    const base = { has_payment_method: true, delinquent: false, unpaid: [], publishable_key: "pk" };
    expect(paymentIssues({ ...base, dues_retry: null }, t)).toEqual([]);
    expect(paymentIssues(null, t)).toEqual([]);
  });

  it("the gateway's customer-safe message shows under the notice", async () => {
    mockDb.billing.duesRetry = {
      state: "pending",
      reason: "soft_decline",
      attempts: 1,
      max_attempts: 4,
      next_attempt_at: NEXT,
      last_decline_code: "insufficient_funds",
      last_error_message: "Your card has insufficient funds.",
      amount_cents: 1200,
      currency: "usd",
      pay_url: "/pay/tok_dues",
    };
    banner();
    const issue = await screen.findByTestId("payment-issue-dues_retry");
    expect(within(issue).getByTestId("payment-issue-detail-dues_retry").textContent).toBe("Your card has insufficient funds.");
    expect(issue.textContent).not.toContain("insufficient_funds");
  });
});

describe("a failed web group being retried (gateway ffa5785)", () => {
  const pending: PaymentRetry & { state: "pending" } = {
    state: "pending",
    reason: "soft_decline",
    attempts: 1,
    max_attempts: 3,
    next_attempt_at: NEXT,
    last_error_message: "Your card was declined.",
    amount_cents: 375,
    pay_url: "/pay/tok_owed",
  };
  function failedGroup(retry: PaymentRetry | null): void {
    mockDb.billing.unpaid.push({
      batch_id: "bgroup000001",
      amount_cents: 375,
      currency: "usd",
      needs_action: false,
      ...(retry ? { retry } : {}),
    });
    mockDb.billing.batchRetry = retry;
  }
  function screenWithSettle(): void {
    render(
      <AuthProvider>
        <BillingProvider>
          <SettleProvider>
            <BalanceDialogsProvider>
              <BillingScreen />
            </BalanceDialogsProvider>
          </SettleProvider>
        </BillingProvider>
      </AuthProvider>,
    );
  }

  it("pending: the banner says when we'll try again, with the reason, and Pay now opens the settle sheet", async () => {
    failedGroup(pending);
    screenWithSettle();
    const issue = await screen.findByTestId("payment-issue-batch_retry");
    expect(issue.textContent).toContain("A payment didn't go through. We'll try again on Nov 9.");
    expect(within(issue).getByTestId("payment-issue-detail-batch_retry").textContent).toBe("Your card was declined.");
    // one line for the debt, not two
    expect(screen.queryByTestId("payment-issue-owed")).toBeNull();
    fireEvent.click(within(issue).getByTestId("payment-issue-pay-batch_retry"));
    expect(await screen.findByTestId("settle-sheet")).toBeTruthy();
  });

  it("pending with one tap offered: Pay now leads with it", async () => {
    failedGroup(pending);
    mockDb.oneTap = { ...mockDb.oneTap, enabled: true };
    screenWithSettle();
    fireEvent.click(await screen.findByTestId("payment-issue-pay-batch_retry"));
    expect((await screen.findByTestId("one-tap-pay")).textContent).toBe("Pay US$3.75 with Visa •••• 4242");
  });

  it("final: the owed banner with the reason and Pay now", async () => {
    failedGroup({ ...pending, state: "final", next_attempt_at: null });
    banner();
    const issue = await screen.findByTestId("payment-issue-owed");
    expect(issue.textContent).toContain("You have $3.75 to pay.");
    expect(within(issue).getByTestId("payment-issue-detail-owed").textContent).toBe("Your card was declined.");
    expect(within(issue).getByTestId("payment-issue-pay-owed").textContent).toBe("Pay now");
    expect(screen.queryByTestId("payment-issue-batch_retry")).toBeNull();
  });

  it("the Payment needed row says when we'll try again", async () => {
    failedGroup(pending);
    screenWithSettle();
    const line = await screen.findByTestId("row-retry");
    expect(line.textContent).toBe("A payment didn't go through. We'll try again on Nov 9.");
  });

  it("an app account (no retry anywhere): the owed banner and the row as before", async () => {
    failedGroup(null);
    screenWithSettle();
    const issue = await screen.findByTestId("payment-issue-owed");
    expect(within(issue).queryByTestId("payment-issue-detail-owed")).toBeNull();
    await screen.findByTestId("row-row_outstanding");
    expect(screen.queryByTestId("row-retry")).toBeNull();
    expect(screen.queryByTestId("payment-issue-batch_retry")).toBeNull();
  });
});
