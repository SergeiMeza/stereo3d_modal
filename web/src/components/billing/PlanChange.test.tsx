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
import { optionFor, ScheduledChange } from "./PlanChange";

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
      // owner 2026-11-05: the dialog's own wording (nextPlanLine)
      "Your Studio stays on until Jan 10, 2027. Business starts then at $299 a month.",
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

  it("Business moves up to Studio at once, priced by the preview", async () => {
    const end = new Date(Date.now() + 20 * 86_400_000).toISOString();
    mockDb.billing.plan = {
      plan: "business",
      name: "Business",
      status: "active",
      active: true,
      monthly_cents: 29900,
      credit_cents: 40000,
      credit_left_cents: 5000,
      cancel_at_period_end: false,
      current_period_end: end,
    };
    wrap(<PlanCard />);
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "Change plan" }),
      { key: "Enter" },
    );
    expect(screen.queryByRole("menuitem", { name: "Business" })).toBeNull();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Studio (move up)" }),
    );
    const line = await screen.findByTestId("plan-change-line");
    // paid $299 × min(time left, usage left $50 of $400) = $37.38
    await waitFor(() =>
      expect(line.textContent).toBe(
        "Today: $11,950.62. Studio $11,988.00 − $37.38 for your unused Business.",
      ),
    );
    expect(
      screen.getByText(
        "Your remaining Business usage this month ends when Studio's $1,500 starts.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "How we work this out" }),
    );
    expect(
      await screen.findByText(
        "We credit what you paid for the time and usage you have left, whichever is smaller.",
      ),
    ).toBeTruthy();
    expect(mockDb.billing.plan?.plan).toBe("business");
    fireEvent.click(
      screen.getByRole("button", { name: "Pay $11,950.62 and change" }),
    );
    await waitFor(() => expect(mockDb.billing.plan?.plan).toBe("studio"));
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
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "Change plan" }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Business" }));
    await waitFor(() =>
      expect(screen.getByTestId("plan-change-line").textContent).toContain(
        "Business starts then",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Change to Business" }));
    expect(
      await screen.findByText(
        "The price was updated. Check it and confirm again.",
      ),
    ).toBeTruthy();
    expect(mockDb.billing.plan?.scheduled_change ?? null).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change to Business" }));
    await waitFor(() =>
      expect(mockDb.billing.plan?.scheduled_change?.to).toBe("business"),
    );
  });

  it("a web Pro's step-down shows on its plan with Keep", async () => {
    mockDb.proStatus = {
      pro: true,
      known: true,
      source: "plan",
      plan_id: "pro_yearly",
      via: "pro_yearly",
    };
    mockDb.billing.plan = {
      plan: "pro",
      plan_id: "pro_yearly",
      name: "Pro Yearly",
      status: "active",
      active: true,
      cancel_at_period_end: false,
      current_period_end: "2027-11-04T00:00:00Z",
      interval: "year",
      price_cents: 7999,
      scheduled_change: {
        to: "pro_monthly",
        effective_at: "2027-11-04T00:00:00Z",
      },
    };
    wrap(<ScheduledChange plan={mockDb.billing.plan} />);
    const notice = await screen.findByTestId("scheduled-change");
    await waitFor(() =>
      expect(notice.textContent).toContain(
        "Your Pro Yearly stays on until Nov 4, 2027. Pro Monthly starts then.",
      ),
    );
    fireEvent.click(
      within(notice).getByRole("button", { name: "Keep Pro Yearly" }),
    );
    await waitFor(() =>
      expect(mockDb.billing.plan?.scheduled_change).toBeNull(),
    );
  });
});

describe("the next plan from scheduled_change.to (gateway 00138)", () => {
  function studioWaiting(to: string): void {
    studio();
    mockDb.billing.plan!.scheduled_change = { to, effective_at: "2027-01-10T12:00:00Z" };
  }

  it.each(["pay_per_video", "none"])("%s reads as pay per video, never Pro", async (to) => {
    studioWaiting(to);
    wrap(<ScheduledChange plan={mockDb.billing.plan!} />);
    const notice = await screen.findByTestId("scheduled-change");
    expect(notice.textContent).toContain("Your Studio stays on until Jan 10, 2027. After that you pay per video.");
    expect(notice.textContent).not.toContain("Pro");
  });

  it("an id this build doesn't know names no plan", async () => {
    studioWaiting("enterprise_2028");
    wrap(<ScheduledChange plan={mockDb.billing.plan!} />);
    const notice = await screen.findByTestId("scheduled-change");
    expect(notice.textContent).toContain("Your Studio stays on until Jan 10, 2027.");
    expect(notice.textContent).not.toMatch(/Pro|starts then|pay per video/);
  });

  it("optionFor: none is pay per video, an unknown id isn't Pro", () => {
    expect(optionFor("none", null, new Map())).toEqual({ id: "pay_per_video", name: null });
    expect(optionFor("pay_per_video", null, new Map())).toEqual({ id: "pay_per_video", name: null });
    expect(optionFor("enterprise_2028", null, new Map())).toMatchObject({ name: null, unknown: true });
    expect(optionFor("pro_monthly", null, new Map())).toMatchObject({ name: "Pro" });
  });
});

