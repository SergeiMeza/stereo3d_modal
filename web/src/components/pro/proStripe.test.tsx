/**
 * Web Pro on our own Stripe subscriptions (owner 2026-11-04): plans from
 * GET /v1/pricing pro_plans, the checkout in our sheet, POST
 * /v1/pro/refresh after it; a web Pro switches period after a preview,
 * and nothing is charged before confirm.
 */

import {
  cleanup,
  fireEvent,
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

import { plansFromPricing } from "@/lib/pro/plans";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { resetProForTests } from "@/lib/pro/usePro";
import { MOCK_PRO_PLANS, mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { ProCheckoutHost } from "./ProCheckoutHost";
import { ProPeriodChange } from "./ProPeriodChange";
import { ProPlans } from "./ProPlans";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pro",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  resetPricingCache();
  resetProForTests();
  (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  delete (globalThis as { __mockDb?: typeof mockDb }).__mockDb;
});
afterAll(() => server.close());

const wrap = (el: React.ReactElement) =>
  render(
    <AuthProvider>
      <BillingProvider>
        {el}
        <ProCheckoutHost />
      </BillingProvider>
    </AuthProvider>,
  );

describe("web Pro on Stripe", () => {
  it("maps pro_plans with their intros", () => {
    const plans = plansFromPricing(MOCK_PRO_PLANS);
    expect(plans.map((p) => [p.id, p.kind, p.price, p.intro?.price])).toEqual([
      ["pro_weekly", "weekly", "$5.99", "$3.99"],
      ["pro_monthly", "monthly", "$8.99", undefined],
      ["pro_yearly", "yearly", "$79.99", "$47.99"],
    ]);
  });

  it("Get Pro pays in our sheet; Pro is on after it, nothing charged before", async () => {
    const done = vi.fn();
    wrap(<ProPlans onPurchased={done} />);
    fireEvent.click(await screen.findByTestId("pro-plan-monthly"));
    fireEvent.click(screen.getByTestId("pro-get"));
    const pay = await screen.findByTestId("pro-stripe-pay");
    expect(pay.textContent).toContain("Start Pro · $8.99");
    expect(
      screen.getByText("Renews at $8.99 a month until you cancel."),
    ).toBeTruthy();
    expect(mockDb.pro).not.toBe(true);
    await waitFor(() =>
      expect(
        (screen.getByTestId("pro-stripe-pay") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId("pro-stripe-pay"));
    await waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 5000 });
    expect(mockDb.pro).toBe(true);
  });

  it("a web Pro switches period after the preview", async () => {
    mockDb.proStatus = {
      pro: true,
      known: true,
      source: "stripe",
      via: "pro_monthly",
    };
    wrap(<ProPeriodChange />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch to Yearly" }),
    );
    const preview = await screen.findByTestId("pro-change-preview");
    await waitFor(() =>
      expect(preview.textContent).toBe(
        "Today: $75.49. Pro Yearly $79.99 − $4.50 for your unused Pro Monthly.",
      ),
    );
    expect(mockDb.planChanges).toEqual([]);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm and pay $75.49" }),
    );
    await waitFor(() => expect(mockDb.planChanges).toEqual(["pro_yearly"]));
  });
});
