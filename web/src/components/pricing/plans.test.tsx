/**
 * Pricing 2026-11 on /pricing and /plans: list and With Pro columns,
 * add-ons, free previews, top-ups, Business and Studio cards, starting a
 * plan in our sheet and the plan on Billing.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingScreen } from "@/components/billing/BillingScreen";
import { BalanceDialogsProvider } from "@/components/pay/BalanceDialogs";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { planLines } from "./PlansSection";
import { PricingScreen } from "./PricingScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pricing",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  mockDb.tierPricing = true;
  resetPricingCache();
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  resetPricingCache();
});
afterAll(() => server.close());

function renderPricing() {
  render(
    <AuthProvider>
      <BillingProvider>
        <PricingScreen />
      </BillingProvider>
    </AuthProvider>,
  );
}

describe("Pricing 2026-11", () => {
  it("list prices with Pro beside them, add-ons, free previews and top-ups", async () => {
    renderPricing();
    const lifelike = await screen.findByTestId("pricing-lifelike");
    expect(lifelike.textContent).toContain("from $4 a minute");
    expect(lifelike.textContent).toContain("With Pro");
    expect(screen.getByTestId("pro-4k").textContent).toBe("$8.50");
    expect(lifelike.textContent).toContain("4K3840×2160 per eye$10.00");
    const addons = screen.getByTestId("pricing-addons");
    expect(addons.textContent).toContain("Master bitrate+20%");
    expect(addons.textContent).toContain("Express+50%");
    expect(addons.textContent).toContain("Up to about 2× faster on longer videos");
    expect(screen.getByTestId("pricing-free-previews").textContent).toContain("Your first preview is free.");
    expect(screen.getByTestId("pricing-topups").textContent).toContain("from $10");
    // the range is GET /v1/pricing's tier shares (Pro 15%, Business 20%, Studio 25%)
    expect(screen.getByTestId("pricing-subtitle").textContent).toBe("Pay per video. Plans save 15–25%.");
    expect(within(screen.getByTestId("pricing-subtitle")).getByRole("link", { name: "Plans" }).getAttribute("href")).toBe("/plans");
    expect(lifelike.textContent).toContain("With Pro (−15%)");
    expect(document.body.textContent).not.toMatch(/Lifetime|depth map|splat|inpaint|Gaussian|no subscription/i);
  });

  it("Business and Studio cards; choosing one pays in our sheet and shows the plan on Billing", async () => {
    renderPricing();
    const biz = await screen.findByTestId("plan-business");
    expect(biz.textContent).toContain("$299 a month");
    expect(biz.textContent).toContain("$400 of usage every month");
    expect(biz.textContent).toContain("20% off every run");
    expect(screen.getByTestId("plan-studio").textContent).toContain("25% off every run");
    expect(biz.textContent).toContain("50 free previews a month");
    expect(biz.textContent).toContain("Express included");
    expect(screen.getByTestId("plan-studio").textContent).toContain("$999 a month");
    fireEvent.click(await within(biz).findByTestId("choose-business"));
    const main = await screen.findByTestId("plan-main");
    expect(main.textContent).toContain("Start Business · $299.00");
    await waitFor(() => expect((screen.getByTestId("plan-main") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("plan-main"));
    expect(await screen.findByText("Business is on. $400 of usage is ready.")).toBeTruthy();
    expect(mockDb.billing.plan?.plan).toBe("business");
    cleanup();
    render(
      <AuthProvider>
        <BillingProvider>
          <BalanceDialogsProvider>
            <BillingScreen />
          </BalanceDialogsProvider>
        </BillingProvider>
      </AuthProvider>,
    );
    const card = await screen.findByTestId("plan-card");
    expect(within(card).getByTestId("plan-credit").textContent).toBe("$400.00 of $400.00 usage left this month");
    fireEvent.click(within(card).getByRole("button", { name: "Cancel plan" }));
    await waitFor(() => expect(mockDb.billing.plan?.cancel_at_period_end).toBe(true));
    expect(await within(card).findByRole("button", { name: "Keep my plan" })).toBeTruthy();
  });

  it("plan card lines", () => {
    expect(
      planLines(
        { name: "Studio", monthly_cents: 99900, credit_cents: 150000, max_active_runs: 8, seats: 10, free_previews_per_period: 200, express_included: true, max_fps: 120 },
        0.25,
      ),
    ).toEqual(["$1,500 of usage every month", "25% off every run", "Commercial use of your videos", "200 free previews a month", "Express included", "Up to 120 fps", "10 people · invoices"]);
  });
});
