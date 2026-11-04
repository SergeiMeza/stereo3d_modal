/**
 * Step-downs (owner 2026-11-04): a lower plan starts at the end of the
 * paid period, nothing is charged today, and Keep undoes it until then.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

import { ProPeriodChange } from "@/components/pro/ProPeriodChange";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { resetProForTests } from "@/lib/pro/usePro";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { PlanCard } from "./PlanCard";
import { ScheduledChange } from "./PlanChange";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/account/billing",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  resetPricingCache();
  resetProForTests();
  mockDb.tierPricing = true;
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
      <BillingProvider>{el}</BillingProvider>
    </AuthProvider>,
  );

function studio(): void {
  mockDb.billing.plan = {
    plan: "studio",
    name: "Studio",
    status: "active",
    active: true,
    monthly_cents: 99900,
    credit_cents: 150000,
    credit_left_cents: 150000,
    cancel_at_period_end: false,
    current_period_end: "2027-01-10T12:00:00Z",
    interval: "year",
    price_cents: 1198800,
  };
}

describe("step-downs", () => {
  it("Studio → Business waits for the period's end; Keep Studio undoes it", async () => {
    studio();
    wrap(<PlanCard />);
    const card = await screen.findByTestId("plan-card");
    fireEvent.keyDown(
      within(card).getByRole("button", { name: "Change plan" }),
      { key: "Enter" },
    );
    expect(
      await screen.findByRole("menuitem", { name: "Business" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Pro Monthly" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Business" }));
    const line = await screen.findByTestId("plan-change-line");
    await waitFor(() =>
      expect(line.textContent).toBe(
        "Your Studio stays on until Jan 10, 2027. Business starts then at $299 a month. Nothing is charged today.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Change to Business" }));
    await waitFor(() =>
      expect(mockDb.billing.plan?.scheduled_change).toEqual({
        to: "business",
        effective_at: "2027-01-10T12:00:00Z",
      }),
    );
    const notice = await screen.findByTestId("scheduled-change");
    expect(notice.textContent).toContain(
      "Business starts on Jan 10, 2027. Your Studio stays on until then.",
    );
    expect(
      within(card).queryByRole("button", { name: "Change plan" }),
    ).toBeNull();
    fireEvent.click(
      within(notice).getByRole("button", { name: "Keep Studio" }),
    );
    await waitFor(() =>
      expect(mockDb.billing.plan?.scheduled_change).toBeNull(),
    );
  });

  it("Business never lists Studio (on hold)", async () => {
    mockDb.billing.plan = {
      plan: "business",
      name: "Business",
      status: "active",
      active: true,
      monthly_cents: 29900,
      credit_cents: 40000,
      credit_left_cents: 40000,
      cancel_at_period_end: false,
      current_period_end: "2026-12-04T00:00:00Z",
    };
    wrap(<PlanCard />);
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "Change plan" }),
      { key: "Enter" },
    );
    await screen.findByRole("menuitem", {
      name: "Pay per video (cancel plan)",
    });
    expect(screen.queryByRole("menuitem", { name: "Studio" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Business" })).toBeNull();
  });

  it("Pro Yearly → Monthly waits too, nothing charged today", async () => {
    mockDb.proStatus = {
      pro: true,
      known: true,
      source: "stripe",
      via: "pro_yearly",
    };
    wrap(<ProPeriodChange />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch to Monthly" }),
    );
    const preview = await screen.findByTestId("pro-change-preview");
    await waitFor(() =>
      expect(preview.textContent).toMatch(
        /^Your Pro Yearly stays on until [A-Z][a-z]{2} \d{1,2}, \d{4}\. Pro Monthly starts then at \$8\.99 a month\. Nothing is charged today\.$/,
      ),
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });

  it("an expired quote is priced again and confirmed again; nothing changes before", async () => {
    studio();
    mockDb.nextChangeExpired = true;
    wrap(<PlanCard />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Change plan" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Business" }));
    await waitFor(() => expect(screen.getByTestId("plan-change-line").textContent).toContain("Business starts then"));
    fireEvent.click(screen.getByRole("button", { name: "Change to Business" }));
    expect(await screen.findByText("The price was updated. Check it and confirm again.")).toBeTruthy();
    expect(mockDb.billing.plan?.scheduled_change ?? null).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change to Business" }));
    await waitFor(() => expect(mockDb.billing.plan?.scheduled_change?.to).toBe("business"));
  });

  it("a web Pro's step-down shows on its plan with Keep", async () => {
    mockDb.proStatus = { pro: true, known: true, source: "plan", plan_id: "pro_yearly", via: "pro_yearly" };
    mockDb.billing.plan = {
      plan: "pro", plan_id: "pro_yearly", name: "Pro Yearly", status: "active", active: true,
      cancel_at_period_end: false, current_period_end: "2027-11-04T00:00:00Z", interval: "year", price_cents: 7999,
      scheduled_change: { to: "pro_monthly", effective_at: "2027-11-04T00:00:00Z" },
    };
    wrap(<ScheduledChange plan={mockDb.billing.plan} />);
    const notice = await screen.findByTestId("scheduled-change");
    await waitFor(() =>
      expect(notice.textContent).toContain("Pro Monthly starts on Nov 4, 2027. Your Pro Yearly stays on until then."),
    );
    fireEvent.click(within(notice).getByRole("button", { name: "Keep Pro Yearly" }));
    await waitFor(() => expect(mockDb.billing.plan?.scheduled_change).toBeNull());
  });
});
