/**
 * Prepaid balance (spec v7 §N, G2 P10 Balance + Usage, P17–P19) against the
 * mock gateway.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BalanceDialogsProvider } from "@/components/pay/BalanceDialogs";
import type { BillingStatus, Conversion } from "@/lib/api/types";
import { prepaidOf } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { awaitPlanCredit, BillingProvider, PLAN_CREDIT_POLL_MAX_MS, PLAN_CREDIT_POLL_MS } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { BillingScreen } from "./BillingScreen";
import { clockOf, recentMonths, usageStatus } from "./UsageTab";

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

const PID = (projectFixture as { project_id: string }).project_id;

function renderBilling() {
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

function topped(cents: number) {
  const pp = mockDb.billing.prepaid;
  pp.balance_cents = cents;
  pp.last_topup_at = "2026-11-01T00:00:00Z";
  pp.topups = 1;
}

describe("the balance and a plan's usage, apart (owner 2026-11-05)", () => {
  function business(left: number): void {
    mockDb.billing.plan = {
      plan: "business",
      name: "Business",
      status: "active",
      active: true,
      monthly_cents: 29900,
      credit_cents: 40000,
      credit_left_cents: left,
      cancel_at_period_end: false,
      current_period_end: "2026-12-05T00:24:08Z",
      interval: "month",
      price_cents: 29900,
    };
  }

  it("a fresh Business plan: Balance $0.00, its $400 on its own line", async () => {
    business(40000);
    // the gateway counts the plan's credit in the balance
    mockDb.billing.prepaid.balance_cents = 40000;
    renderBilling();
    await waitFor(() => expect(screen.getByTestId("balance-amount").textContent).toBe("$0.00"));
    expect(screen.getByTestId("balance-plan-usage").textContent).toBe("Plan usage: $400 left this month · resets on 5 Dec");
  });

  it("top-ups beside a plan: only what keeps is the Balance", async () => {
    business(31250);
    topped(2500 + 31250);
    renderBilling();
    await waitFor(() => expect(screen.getByTestId("balance-amount").textContent).toBe("$25.00"));
    expect(screen.getByTestId("balance-plan-usage").textContent).toBe("Plan usage: $312.50 left this month · resets on 5 Dec");
  });

  it("the gateway's prepaid fields (a0efcfa) set the amount, the hold and the expiry", async () => {
    business(40000);
    topped(2500 + 40000);
    mockDb.billing.prepaid.frozen_cents = 1000;
    mockDb.billing.balanceExtra = {
      frozen_cents: 41000,
      expires_at: "2027-11-01T00:00:00Z",
      prepaid_cents: 1500,
      prepaid_frozen_cents: 1000,
      prepaid_expires_at: "2027-05-01T00:00:00Z",
      plan_credit_cents: 40000,
    };
    renderBilling();
    await waitFor(() => expect(screen.getByTestId("balance-amount").textContent).toBe("$15.00"));
    expect(screen.getByTestId("balance-frozen").textContent).toBe("$10.00 on hold while a payment is reviewed.");
    expect(screen.getByTestId("balance-expires").textContent).toBe("Expires on 1 May 2027 unless you add funds.");
    // the plan's credit keeps its own reset date
    expect(screen.getByTestId("balance-plan-usage").textContent).toBe("Plan usage: $400 left this month · resets on 5 Dec");
  });

  it("no prepaid money: prepaid_expires_at null shows no expiry", async () => {
    business(40000);
    mockDb.billing.prepaid.balance_cents = 40000;
    mockDb.billing.balanceExtra = { expires_at: "2027-11-01T00:00:00Z", prepaid_cents: 0, prepaid_expires_at: null };
    renderBilling();
    await waitFor(() => expect(screen.getByTestId("balance-amount").textContent).toBe("$0.00"));
    expect(screen.queryByTestId("balance-expires")).toBeNull();
  });

  it("after a change, reads again until the plan's usage lands, then stops (latest wins)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      business(0);
      let reads = 0;
      server.events.on("request:start", ({ request }) => {
        if (new URL(request.url).pathname === "/v1/billing") reads += 1;
      });
      renderBilling();
      await waitFor(() => expect(screen.getByTestId("plan-credit").textContent).toBe("$0.00 of $400.00 usage left this month"));
      // two waits: the second wins, one read every 2 s
      void awaitPlanCredit();
      void awaitPlanCredit();
      await vi.advanceTimersByTimeAsync(PLAN_CREDIT_POLL_MS * 2 + 50);
      const before = reads;
      // the webhook's grant lands
      mockDb.billing.plan!.credit_left_cents = 40000;
      await vi.advanceTimersByTimeAsync(PLAN_CREDIT_POLL_MS + 50);
      await waitFor(() => expect(screen.getByTestId("plan-credit").textContent).toBe("$400.00 of $400.00 usage left this month"));
      expect(screen.getByTestId("balance-plan-usage").textContent).toContain("$400 left this month");
      const landed = reads;
      expect(landed - before).toBeLessThanOrEqual(2);
      // and then no more reads
      await vi.advanceTimersByTimeAsync(PLAN_CREDIT_POLL_MAX_MS);
      expect(reads).toBe(landed);
    } finally {
      server.events.removeAllListeners();
      vi.useRealTimers();
    }
  });

  it("gives up after 20 s when the usage never lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      business(0);
      let reads = 0;
      server.events.on("request:start", ({ request }) => {
        if (new URL(request.url).pathname === "/v1/billing") reads += 1;
      });
      renderBilling();
      await screen.findByTestId("plan-credit");
      const start = reads;
      void awaitPlanCredit();
      await vi.advanceTimersByTimeAsync(PLAN_CREDIT_POLL_MAX_MS + PLAN_CREDIT_POLL_MS * 2);
      const done = reads - start;
      expect(done).toBeGreaterThanOrEqual(PLAN_CREDIT_POLL_MAX_MS / PLAN_CREDIT_POLL_MS - 1);
      expect(done).toBeLessThanOrEqual(PLAN_CREDIT_POLL_MAX_MS / PLAN_CREDIT_POLL_MS + 1);
      await vi.advanceTimersByTimeAsync(PLAN_CREDIT_POLL_MS * 3);
      expect(reads - start).toBe(done);
    } finally {
      server.events.removeAllListeners();
      vi.useRealTimers();
    }
  });

  it("no plan: no plan line, the whole balance", async () => {
    topped(2500);
    renderBilling();
    await waitFor(() => expect(screen.getByTestId("balance-amount").textContent).toBe("$25.00"));
    expect(screen.queryByTestId("balance-plan-usage")).toBeNull();
  });
});

describe("prepaidOf", () => {
  it("tells the v7 balance from the old batch field", () => {
    expect(prepaidOf(null)).toBeNull();
    expect(prepaidOf({ balance: { pending_cents: 100 } } as unknown as BillingStatus)).toBeNull();
    const b = { balance_cents: 500, available_cents: 500 };
    expect(prepaidOf({ balance: b } as unknown as BillingStatus)).toBe(b);
  });
});

describe("Balance card (P10)", () => {
  it("never topped up: $0.00 with the hint; rows Off · Set up, None · Set, alert", async () => {
    renderBilling();
    const card = await screen.findByTestId("balance-card");
    expect(within(card).getByTestId("balance-amount").textContent).toBe("$0.00");
    expect(within(card).getByText("Add funds to pay for runs from your balance.")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Set up auto-reload" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Set monthly spend limit" })).toBeTruthy();
    expect(card.textContent).toContain("Below $5.00");
  });

  it("reserved, frozen and expiry lines; a paused auto-reload can be turned back on", async () => {
    topped(4280);
    const pp = mockDb.billing.prepaid;
    pp.holds.set("crun00000001", 675);
    pp.frozen_cents = 2000;
    pp.auto_reload = { enabled: true, below_cents: 1000, add_cents: 2500, paused_reason: "declined" };
    pp.spend_limit_cents = 10000;
    pp.month_spent_cents = 3720;
    renderBilling();
    const card = await screen.findByTestId("balance-card");
    expect(within(card).getByTestId("balance-amount").textContent).toBe("$42.80");
    expect(card.textContent).toContain("$6.75 reserved for 1 run in progress");
    expect(card.textContent).toContain("$20.00 on hold while a payment is reviewed.");
    expect(card.textContent).toMatch(/Expires on .* unless you add funds\./);
    expect(card.textContent).toContain("Below $10.00, add $25.00");
    expect(card.textContent).toContain("$100 a month · $37.20 used");
    fireEvent.click(within(card).getByRole("button", { name: "Turn back on" }));
    await waitFor(() => expect(mockDb.billing.prepaid.auto_reload.paused_reason).toBeUndefined());
    await waitFor(() => expect(screen.queryByTestId("reload-paused")).toBeNull());
  });
});

describe("Add funds (P17)", () => {
  it("adds the chosen amount and shows the new balance", async () => {
    renderBilling();
    fireEvent.click(await screen.findByTestId("balance-add-funds"));
    const sheet = await screen.findByTestId("add-funds-sheet");
    expect(within(sheet).getByRole("radio", { name: "$25" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(sheet).getByRole("radio", { name: "$50" }));
    const main = await screen.findByTestId("add-funds-main");
    await waitFor(() => expect(main.textContent).toContain("Add $50.00"));
    await waitFor(() => expect((screen.getByTestId("add-funds-main") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("add-funds-main"));
    expect(await screen.findByText("Added $50.00. Your balance is $50.00.")).toBeTruthy();
    expect(mockDb.billing.prepaid.balance_cents).toBe(5000);
  });

  it("Other: under $10 and over the first top-up's $100 say so", async () => {
    renderBilling();
    fireEvent.click(await screen.findByTestId("balance-add-funds"));
    const sheet = await screen.findByTestId("add-funds-sheet");
    fireEvent.click(within(sheet).getByRole("radio", { name: "Other" }));
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Amount" }), { target: { value: "5" } });
    expect(await screen.findByText("The minimum is $10.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), { target: { value: "200" } });
    expect(await screen.findByText("You can add up to $100 for your first top-up.")).toBeTruthy();
  });
});

describe("00083 refusals", () => {
  it("the daily top-up cap says what's left today", async () => {
    mockDb.billing.topupDayCents = 97500;
    topped(500);
    renderBilling();
    fireEvent.click(await screen.findByTestId("balance-add-funds"));
    // $25 is preselected and fits; $50 doesn't
    fireEvent.click(within(await screen.findByTestId("add-funds-sheet")).getByRole("radio", { name: "$50" }));
    expect(await screen.findByText("You can add up to $25.00 more today.")).toBeTruthy();
  });

  it.each([
    ["dispute", "Auto-reload can't be turned on while a bank dispute is open."],
    ["payment_failed", "Auto-reload can't be turned on until a failed payment is paid."],
  ] as const)("auto-reload blocked by %s", async (reason, line) => {
    mockDb.billing.autoReloadBlocked = reason;
    renderBilling();
    fireEvent.click(await screen.findByRole("button", { name: "Set up auto-reload" }));
    const dlg = await screen.findByTestId("auto-reload-dialog");
    await within(dlg).findByTestId("reload-consent");
    fireEvent.click(within(dlg).getByTestId("auto-reload-save"));
    expect(await within(dlg).findByText(line)).toBeTruthy();
  });
});

describe("Auto-reload (P18)", () => {
  it("validates the amount, names the default method and saves", async () => {
    renderBilling();
    fireEvent.click(await screen.findByRole("button", { name: "Set up auto-reload" }));
    const dlg = await screen.findByTestId("auto-reload-dialog");
    expect((await within(dlg).findByTestId("reload-consent")).textContent).toContain("(Visa •••• 4242)");
    fireEvent.change(within(dlg).getByRole("textbox", { name: "Add" }), { target: { value: "5" } });
    fireEvent.click(within(dlg).getByTestId("auto-reload-save"));
    expect(await within(dlg).findByText("Add at least $10.")).toBeTruthy();
    fireEvent.change(within(dlg).getByRole("textbox", { name: "When my balance drops below" }), {
      target: { value: "30" },
    });
    fireEvent.change(within(dlg).getByRole("textbox", { name: "Add" }), { target: { value: "20" } });
    fireEvent.click(within(dlg).getByTestId("auto-reload-save"));
    expect(await within(dlg).findByText("Add at least as much as the threshold ($30.00).")).toBeTruthy();
    fireEvent.change(within(dlg).getByRole("textbox", { name: "Add" }), { target: { value: "40" } });
    fireEvent.click(within(dlg).getByTestId("auto-reload-save"));
    expect(await screen.findByText("Auto-reload is on.")).toBeTruthy();
    expect(mockDb.billing.prepaid.auto_reload).toMatchObject({ enabled: true, below_cents: 3000, add_cents: 4000 });
  });

  it("without a saved method it asks for one first", async () => {
    mockDb.billing.methods = [];
    renderBilling();
    fireEvent.click(await screen.findByRole("button", { name: "Set up auto-reload" }));
    const dlg = await screen.findByTestId("auto-reload-dialog");
    expect(await within(dlg).findByText("Save a payment method to use auto-reload.")).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: "Add payment method" })).toBeTruthy();
  });
});

describe("Spending (P19)", () => {
  it("sets a monthly limit and the balance alert", async () => {
    renderBilling();
    fireEvent.click(await screen.findByRole("button", { name: "Set monthly spend limit" }));
    const dlg = await screen.findByTestId("spending-dialog");
    fireEvent.click(within(dlg).getByRole("switch", { name: "Monthly spend limit" }));
    fireEvent.change(within(dlg).getByRole("textbox", { name: "Monthly spend limit" }), { target: { value: "150" } });
    fireEvent.change(within(dlg).getByRole("textbox", { name: "Email me when my balance drops below" }), {
      target: { value: "8" },
    });
    fireEvent.click(within(dlg).getByTestId("spending-save"));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(mockDb.billing.prepaid.spend_limit_cents).toBe(15000);
    expect(mockDb.billing.prepaid.low_balance_cents).toBe(800);
  });
});

describe("Usage tab (P10)", () => {
  it("lists this month's runs with the month picker, CSV and balance history", async () => {
    topped(5000);
    mockDb.billing.prepaid.entries.push({ id: "e1", kind: "topup", cents: 5000, at: "2026-11-01T00:00:00Z" });
    const now = new Date().toISOString();
    const c: Conversion = {
      conversion_id: "cusage000001",
      state: "succeeded",
      kind: "video",
      project_id: PID,
      step: "production",
      method: "lifelike",
      params: { preset: "4k", formats: ["mvhevc"] },
      quote: { amount_cents: 675, currency: "usd" },
      progress: 1,
      billing: { status: "balance_settled", charged_cents: 675 },
      created_at: now,
      updated_at: now,
    };
    mockDb.conversions.set(c.conversion_id, c);
    renderBilling();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Usage" }));
    const row = await screen.findByTestId("usage-cusage000001");
    expect(row.textContent).toContain("Lifelike");
    expect(row.textContent).toContain("$6.75");
    expect(row.textContent).toContain("Balance");
    expect(row.textContent).toContain("Done");
    expect(screen.getByRole("combobox", { name: "Month" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeTruthy();
    expect((await screen.findByTestId("balance-history")).textContent).toContain("Top-up");
  });

  it("helpers: months, clock and statuses", () => {
    const m = recentMonths(new Date("2026-01-15T00:00:00Z"));
    expect(m.slice(0, 2)).toEqual(["2026-01", "2025-12"]);
    expect(m).toHaveLength(12);
    expect(clockOf(2.25)).toBe("2:15");
    const base = { at: "", project: "", conversion_id: "", method: "classic", preset: "4k", minutes: 1, cost_cents: 0, paid_with: "balance" } as const;
    expect(usageStatus({ ...base, status: "running", reserved_cents: 675 }).text).toBe("Running, reserved $6.75");
    expect(usageStatus({ ...base, status: "returned", returned_cents: 200 }).text).toBe("Returned to balance $2.00");
  });
});

describe("Pro's monthly credit (owner 2026-11-07)", () => {
  const credit = (over: Partial<NonNullable<BillingStatus["pro_credit"]>> = {}) => {
    mockDb.pro = true;
    mockDb.proCredit = {
      cents_per_month: 2000,
      kind: "pro_monthly",
      source: "app_store",
      trial: false,
      period_start: "2026-11-01T00:00:00Z",
      period_end: "2026-12-01T00:00:00Z",
      granted: true,
      left_cents: 1240,
      ...over,
    };
  };

  it("shows what's left this month and when it expires, like a plan's usage, apart from the Balance", async () => {
    credit();
    // the gateway counts the credit in the balance, like a plan's
    mockDb.billing.prepaid.balance_cents = 1240 + 500;
    renderBilling();
    const card = await screen.findByTestId("pro-credit-card");
    expect(within(card).getByTestId("pro-credit-left").textContent).toBe("$12.40 of $20.00 Pro credit left this month");
    expect(within(card).getByTestId("pro-credit-expires").textContent).toBe("Expires on 1 Dec and isn't paid out.");
    await waitFor(() => expect(screen.getByTestId("balance-amount").textContent).toBe("$5.00"));
    expect(screen.getByTestId("balance-pro-credit").textContent).toBe("Pro credit: $12.40 left this month · expires on 1 Dec");
  });

  it("a trial's credit says the trial includes it; Lifetime shows its own amount", async () => {
    credit({ trial: true, cents_per_month: 1000, left_cents: 1000, kind: "pro_lifetime" });
    renderBilling();
    const card = await screen.findByTestId("pro-credit-card");
    expect(card.textContent).toContain("$10.00 of $10.00 Pro credit left this month");
    expect(card.textContent).toContain("Your free trial includes it.");
  });

  it("nothing when it isn't granted to this account, or there's none", async () => {
    credit({ granted: false });
    renderBilling();
    await screen.findByTestId("balance-amount");
    expect(screen.queryByTestId("pro-credit-card")).toBeNull();
    expect(screen.queryByTestId("balance-pro-credit")).toBeNull();
    cleanup();
    mockDb.proCredit = null;
    renderBilling();
    await screen.findByTestId("balance-amount");
    expect(screen.queryByTestId("pro-credit-card")).toBeNull();
  });
});
