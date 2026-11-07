/**
 * BUX-23 (proposal): bonus usage credit on bigger top-ups (+5% at $50,
 * +10% at $100), behind GET /v1/pricing topup_bonus, off by default (the
 * mock too). Never refunded or paid out, and it says so.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { AddFundsSheet } from "./BalanceDialogs";
import { firstBonusTier, topupBonusCents, topupDone } from "./payCopy";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/account/billing",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));

const TIERS = { tiers: [{ min_cents: 5000, pct: 0.05 }, { min_cents: 10000, pct: 0.1 }] };

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => resetPricingCache());
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function sheet(): void {
  render(
    <AuthProvider>
      <BillingProvider>
        <AddFundsSheet onClose={vi.fn()} />
      </BillingProvider>
    </AuthProvider>,
  );
}

describe("top-up bonus (BUX-23 proposal)", () => {
  it("the tiers: the highest reached, to the cent; nothing while off", () => {
    expect(topupBonusCents(2500, TIERS)).toBe(0);
    expect(topupBonusCents(5000, TIERS)).toBe(250);
    expect(topupBonusCents(7500, TIERS)).toBe(375);
    expect(topupBonusCents(10000, TIERS)).toBe(1000);
    expect(topupBonusCents(10000, null)).toBe(0);
    expect(firstBonusTier(TIERS)).toEqual({ min_cents: 5000, pct: 0.05 });
    expect(topupDone(5000, 5250, undefined, 250)).toBe("Added $50.00 + $2.50 bonus. Your balance is $52.50.");
  });

  it("off by default (the mock too): no bonus line, the top-up as today", async () => {
    expect(mockDb.topupBonus).toBeNull();
    sheet();
    const s = await screen.findByTestId("add-funds-sheet");
    fireEvent.click(within(s).getByRole("radio", { name: "$50" }));
    await waitFor(() => expect((screen.getByTestId("add-funds-main") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("topup-bonus")).toBeNull();
    expect(screen.queryByTestId("topup-bonus-from")).toBeNull();
  });

  it("on: $25 says where it starts, $50 shows its bonus and that it isn't refundable, and the balance gets it", async () => {
    mockDb.topupBonus = TIERS;
    sheet();
    const s = await screen.findByTestId("add-funds-sheet");
    expect((await screen.findByTestId("topup-bonus-from")).textContent).toBe("Add $50 or more and get 5% bonus credit.");
    fireEvent.click(within(s).getByRole("radio", { name: "$50" }));
    expect(screen.getByTestId("topup-bonus").textContent).toBe(
      "+$2.50 bonus credit with this top-up. Bonus credit can't be refunded or paid out.",
    );
    await waitFor(() => expect((screen.getByTestId("add-funds-main") as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(screen.getByTestId("add-funds-main").textContent).toContain("Add $50.00"));
    fireEvent.click(screen.getByTestId("add-funds-main"));
    expect(await screen.findByText("Added $50.00 + $2.50 bonus. Your balance is $52.50.")).toBeTruthy();
    expect(mockDb.billing.prepaid.entries[0]).toMatchObject({ kind: "topup_bonus", cents: 250 });
  });
});
