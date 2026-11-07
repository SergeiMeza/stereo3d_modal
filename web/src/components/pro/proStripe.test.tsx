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
  it("maps pro_plans with their monthly credit (owner 2026-11-07)", () => {
    const plans = plansFromPricing(MOCK_PRO_PLANS);
    expect(plans.map((p) => [p.id, p.kind, p.price, p.creditCents])).toEqual([
      ["pro_weekly", "weekly", "$3.99", 2000],
      ["pro_monthly", "monthly", "$4.99", 2000],
      ["pro_yearly", "yearly", "$49.99", 2000],
    ]);
  });

  it("Get Pro pays in our sheet; Pro is on after it, nothing charged before", async () => {
    const done = vi.fn();
    wrap(<ProPlans onPurchased={done} />);
    fireEvent.click(await screen.findByTestId("pro-plan-monthly"));
    fireEvent.click(screen.getByTestId("pro-get"));
    const pay = await screen.findByTestId("pro-stripe-pay");
    expect(pay.textContent).toContain("Start Pro · $4.99");
    expect(
      screen.getByText("Renews at $4.99 a month until you cancel."),
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
        "Today: $45.49. Pro Yearly $49.99 − $4.50 for your unused Pro Monthly.",
      ),
    );
    expect(mockDb.planChanges).toEqual([]);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm and pay $45.49" }),
    );
    await waitFor(() => expect(mockDb.planChanges).toEqual(["pro_yearly"]));
  });
});

describe("Pro Weekly behind web_pro_weekly_hidden (BUX-24, gateway 8960553)", () => {
  function pricingReads(): { n: number } {
    const c = { n: 0 };
    server.events.on("request:start", ({ request }) => {
      if (request.method === "GET" && new URL(request.url).pathname === "/v1/pricing") c.n += 1;
    });
    return c;
  }

  it("off: Weekly is offered and pays", async () => {
    wrap(<ProPlans onPurchased={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("pro-plan-weekly"));
    fireEvent.click(screen.getByTestId("pro-get"));
    expect((await screen.findByTestId("pro-stripe-pay")).textContent).toContain("Start Pro · $3.99");
    expect(screen.queryByTestId("pro-stripe-error")).toBeNull();
  });

  it("on: Weekly isn't offered", async () => {
    mockDb.webProWeeklyHidden = true;
    wrap(<ProPlans onPurchased={vi.fn()} />);
    await screen.findByTestId("pro-plan-monthly");
    expect(screen.queryByTestId("pro-plan-weekly")).toBeNull();
  });

  it("turned on after the page loaded: 409 plan_unavailable says so, reads the prices again and drops Weekly", async () => {
    const reads = pricingReads();
    wrap(<ProPlans onPurchased={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("pro-plan-weekly"));
    mockDb.webProWeeklyHidden = true;
    const before = reads.n;
    fireEvent.click(screen.getByTestId("pro-get"));
    expect((await screen.findByTestId("pro-stripe-error")).textContent).toBe(
      "That plan isn't offered here any more. Choose another one.",
    );
    // read again after the refusal
    await waitFor(() => expect(reads.n).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByTestId("pro-plan-weekly")).toBeNull());
    expect(mockDb.pro).not.toBe(true);
  });

  it("a change to Weekly refused the same way reads the prices again", async () => {
    mockDb.proStatus = { pro: true, known: true, source: "stripe", via: "pro_monthly" };
    const reads = pricingReads();
    wrap(<ProPeriodChange />);
    const toWeekly = await screen.findByRole("button", { name: "Switch to Weekly" });
    mockDb.webProWeeklyHidden = true;
    const before = reads.n;
    fireEvent.click(toWeekly);
    await waitFor(() => expect(reads.n).toBeGreaterThan(before));
    expect(mockDb.planChanges).toEqual([]);
  });
});
