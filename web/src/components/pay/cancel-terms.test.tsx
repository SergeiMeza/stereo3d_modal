/**
 * BUX-13: the last screen before a plan or Pro payment says how it renews
 * and how to cancel.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PricingScreen } from "@/components/pricing/PricingScreen";
import { ProCheckoutHost } from "@/components/pro/ProCheckoutHost";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { openProCheckout } from "@/lib/pro/checkoutStore";
import { plansFromPricing } from "@/lib/pro/plans";
import { resetProForTests } from "@/lib/pro/usePro";
import { MOCK_PRO_PLANS, mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

const CANCEL = "Cancel any time in Plan & billing. Your plan runs to the end of the paid period.";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pricing",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetProForTests();
  resetPricingCache();
  mockDb.reset();
  delete (globalThis as { __mockDb?: typeof mockDb }).__mockDb;
});
afterAll(() => server.close());

describe("cancel terms before paying (BUX-13)", () => {
  it("a Business plan: billed monthly, renews, and how to cancel", async () => {
    mockDb.tierPricing = true;
    (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
    render(
      <AuthProvider>
        <BillingProvider>
          <PricingScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    const card = await screen.findByTestId("plan-business");
    fireEvent.click(await within(card).findByTestId("choose-business"));
    await screen.findByTestId("plan-main");
    const lines = within(screen.getByTestId("plan-sheet")).getByTestId("pay-lines");
    expect(lines.textContent).toMatch(/Billed monthly\. Renews on .+ until you cancel\./);
    expect(lines.textContent).toContain(CANCEL);
  });

  it("Pro: the price it renews at, and how to cancel", async () => {
    render(
      <AuthProvider>
        <BillingProvider>
          <ProCheckoutHost />
        </BillingProvider>
      </AuthProvider>,
    );
    void openProCheckout(plansFromPricing(MOCK_PRO_PLANS).find((p) => p.kind === "yearly")!);
    await screen.findByTestId("pro-stripe-pay");
    const lines = screen.getByTestId("pay-lines");
    expect(lines.textContent).toContain("Renews at $49.99 a year until you cancel.");
    expect(lines.textContent).toContain(CANCEL);
  });
});
