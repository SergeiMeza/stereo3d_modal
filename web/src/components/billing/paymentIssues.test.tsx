/**
 * Owner 2026-11-07 (D): a plan's renewal past due and payments being
 * retried show on Billing and on the projects pages' banner, each with
 * Pay now to its pay page; the plan's benefits are never said to stop,
 * and auto-reload reads as paused while its reload is retried.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import AccountScreen from "@/components/auth/AccountScreen";
import { BalanceDialogsProvider } from "@/components/pay/BalanceDialogs";
import type { AccountPlan } from "@/lib/api/types";
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

  it("paid or canceled retries show nothing", () => {
    const t = makeTr("en", null);
    const base = { has_payment_method: true, delinquent: false, unpaid: [], publishable_key: "pk" };
    expect(paymentIssues({ ...base, dues_retry: { state: "paid", amount_cents: 100 } }, t)).toEqual([]);
    expect(paymentIssues({ ...base, dues_retry: { state: "canceled", amount_cents: 100 } }, t)).toEqual([]);
    expect(paymentIssues(null, t)).toEqual([]);
  });
});
