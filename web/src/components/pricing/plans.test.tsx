/**
 * Pricing 2026-11 on /pricing and /plans: list and With Pro columns,
 * add-ons, free previews, top-ups, Business and Studio cards, starting a
 * plan in our sheet and the plan on Billing.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingScreen } from "@/components/billing/BillingScreen";
import { BalanceDialogsProvider } from "@/components/pay/BalanceDialogs";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { planSubtitle } from "@/components/pay/PlanSheet";
import type { PlanDef } from "@/lib/api/types";

import { planLines } from "./PlansSection";
import { PlansScreen } from "./PlansScreen";
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

function onPlan(plan: "business" | "studio"): void {
  const studio = plan === "studio";
  mockDb.billing.plan = {
    plan,
    name: studio ? "Studio" : "Business",
    status: "active",
    active: true,
    monthly_cents: studio ? 99900 : 29900,
    credit_cents: studio ? 150000 : 40000,
    credit_left_cents: studio ? 150000 : 40000,
    cancel_at_period_end: false,
    current_period_end: "2026-12-05T00:24:08Z",
    interval: studio ? "year" : "month",
    price_cents: studio ? 1198800 : 29900,
  };
}

function renderPlans() {
  render(
    <AuthProvider>
      <BillingProvider>
        <PlansScreen />
      </BillingProvider>
    </AuthProvider>,
  );
}

describe("between Business and Studio (owner bug 2026-11-05)", () => {
  it("on Business, Change to Studio opens the step-up and changes the plan", async () => {
    onPlan("business");
    renderPlans();
    const studio = await screen.findByTestId("plan-studio");
    const choose = await within(studio).findByTestId("choose-studio");
    await waitFor(() => expect(choose.textContent).toBe("Change to Studio"));
    expect((choose as HTMLButtonElement).disabled).toBe(false);
    expect(within(screen.getByTestId("plan-business")).getByRole("button", { name: "Your plan" })).toBeTruthy();
    // the Pro card: included, nothing to buy
    const proCard = screen.getByTestId("plan-pro");
    expect(within(proCard).getByTestId("plan-pro-included").textContent).toBe("Included in Business");
    expect(within(proCard).queryByRole("link", { name: "Get Pro" })).toBeNull();
    fireEvent.click(choose);
    const sheet = await screen.findByTestId("plan-change-sheet");
    expect(sheet.textContent).toContain("Instead of your Business");
    const line = await within(sheet).findByTestId("plan-change-line");
    expect(line.textContent).toMatch(/^Today: \$[\d,.]+\. Studio \$11,988\.00 − \$[\d,.]+ for your unused Business\.$/);
    expect(sheet.textContent).toContain("Your remaining Business usage this month ends when Studio's $1,500 starts.");
    const main = screen.getByTestId("plan-change-main");
    expect(main.textContent).toMatch(/^Pay \$[\d,.]+ and change$/);
    fireEvent.click(main);
    expect(await screen.findByText("Studio is on. $1,500 of usage is ready.")).toBeTruthy();
    await waitFor(() => expect(mockDb.billing.plan?.plan).toBe("studio"));
  });

  it("a change the gateway refuses says why in plain words, and Try again works", async () => {
    onPlan("business");
    let fails = 1;
    server.use(
      // the first change fails; then the mock gateway answers as usual
      http.post("*/v1/plans/change", () =>
        fails-- > 0
          ? HttpResponse.json({ error: "payment_error", message: "couldn't change the plan; try again" }, { status: 502 })
          : undefined,
      ),
    );
    renderPlans();
    const choose = await within(await screen.findByTestId("plan-studio")).findByTestId("choose-studio");
    await waitFor(() => expect(choose.textContent).toBe("Change to Studio"));
    fireEvent.click(choose);
    await screen.findByTestId("plan-change-line");
    fireEvent.click(screen.getByTestId("plan-change-main"));
    expect((await screen.findByTestId("plan-change-error")).textContent).toBe(
      "Couldn't change your plan. Try again. Nothing was charged.",
    );
    expect(document.body.textContent).not.toContain("couldn't change the plan; try again");
    const again = screen.getByTestId("plan-change-main");
    expect(again.textContent).toBe("Try again");
    fireEvent.click(again);
    expect(await screen.findByText("Studio is on. $1,500 of usage is ready.")).toBeTruthy();
  });

  it("on Studio, Change to Business waits for the paid year's end and charges nothing today", async () => {
    onPlan("studio");
    renderPlans();
    const choose = await within(await screen.findByTestId("plan-business")).findByTestId("choose-business");
    await waitFor(() => expect(choose.textContent).toBe("Change to Business"));
    expect(within(screen.getByTestId("plan-pro")).getByTestId("plan-pro-included").textContent).toBe("Included in Studio");
    fireEvent.click(choose);
    const line = await screen.findByTestId("plan-change-line");
    expect(line.textContent).toMatch(
      /^Your Studio stays on until [A-Z][a-z]{2} \d{1,2}, \d{4}\. Business starts then at \$299 a month\. Nothing is charged today\.$/,
    );
    const main = screen.getByTestId("plan-change-main");
    expect(main.textContent).toMatch(/^Change to Business on [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    fireEvent.click(main);
    expect((await screen.findByTestId("pay-success")).textContent).toMatch(
      /^Your Studio stays on until [A-Z][a-z]{2} \d{1,2}, \d{4}\. Business starts then at \$299 a month\.$/,
    );
    await waitFor(() => expect(mockDb.billing.plan?.scheduled_change?.to).toBe("business"));
    expect(mockDb.billing.plan?.plan).toBe("studio");
  });
});

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

  it("a cancelled plan runs to the end of the paid month or year (QA 2026-11-05)", () => {
    const base: PlanDef = { name: "Business", monthly_cents: 29900, credit_cents: 40000, max_active_runs: 3, free_previews_per_period: 50, express_included: true };
    expect(planSubtitle({ ...base, interval: "month", price_cents: 29900 })).toBe(
      "$400 of usage every month · cancel any time; it runs to the end of the paid month",
    );
    expect(planSubtitle({ ...base, name: "Studio", credit_cents: 150000, interval: "year", price_cents: 1198800 })).toBe(
      "$1,500 of usage every month · cancel any time; it runs to the end of the paid year",
    );
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
    // Studio bills yearly (gateway 00089): "$11,988 a year", usage monthly
    expect(screen.getByTestId("plan-price-studio").textContent).toBe("$11,988 a year");
    expect(screen.getByTestId("plan-studio").textContent).toContain("$11,988 a year$1,500 of usage every month");
    fireEvent.click(await within(biz).findByTestId("choose-business"));
    const main = await screen.findByTestId("plan-main");
    await waitFor(() => expect((screen.getByTestId("plan-main") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId("plan-sheet").textContent).toContain("cancel any time; it runs to the end of the paid month");
    expect(main.textContent).toContain("Start Business · $299.00");
    // owner 2026-11-05: the method and country only; no address, company
    // name or tax ID (Business details takes them after paying)
    expect(screen.queryByTestId("mock-billing-address")).toBeNull();
    expect(screen.queryByLabelText(/Address|City|Postal code/)).toBeNull();
    expect(screen.queryByText(/Tax ID|Business name|Add business details|Billing address/)).toBeNull();
    expect(screen.getByRole("radio", { name: "Card" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByLabelText("Country"), { target: { value: "JP" } });
    fireEvent.click(screen.getByTestId("plan-main"));
    expect(await screen.findByText("Business is on. $400 of usage is ready.")).toBeTruthy();
    expect(mockDb.billing.plan?.plan).toBe("business");
    // owner 2026-11-05: the welcome's optional link, and the screen waits
    // for it (no welcome follows on /pricing)
    const link = screen.getByTestId("plan-company-link");
    expect(link.textContent).toBe("Add your company details for invoices");
    expect(link.getAttribute("href")).toBe("/account/business-details");
    await new Promise((r) => setTimeout(r, 1700));
    expect(screen.getByTestId("plan-company-link")).toBeTruthy();
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
    // gateway ffac292: the purchase is a history row with its invoice and receipt
    const bought = await screen.findByTestId("row-plan_in_mock_business_1");
    expect(bought.textContent).toContain("Business plan · monthly");
    expect(within(bought).getByTestId("row-amount").textContent).toBe("$299.00");
    expect(within(bought).getByTestId("row-status").textContent).toBe("Paid");
    expect(within(bought).getByRole("link", { name: "Invoice ↗" }).getAttribute("href")).toBe(
      "https://invoice.stripe.com/i/mock/in_mock_business_1",
    );
    expect(within(bought).getByRole("link", { name: "Receipt ↗" }).getAttribute("href")).toBe(
      "https://pay.stripe.com/receipts/mock/in_mock_business_1",
    );
    expect(screen.getByTestId("row-credit_in_mock_business_1").textContent).toContain("Usage credit added · $400.00");
    // owner 2026-11-04: cancelling is "pay per video" in Change plan, at the period's end
    fireEvent.keyDown(within(card).getByRole("button", { name: "Change plan" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pay per video (cancel plan)" }));
    const line = await screen.findByTestId("plan-change-line");
    await waitFor(() =>
      expect(line.textContent).toMatch(/^Your Business stays on until [A-Z][a-z]{2} \d{1,2}, \d{4}\. After that you pay per video\. Nothing is charged today\.$/),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel plan" }));
    // gateway 00102: to pay_per_video, scheduled for the period's end
    await waitFor(() => expect(mockDb.billing.plan?.scheduled_change?.to).toBe("pay_per_video"));
    const notice = await within(card).findByTestId("scheduled-change");
    // the card and the dialog say the same (nextPlanLine)
    expect(notice.textContent).toMatch(/^Your Business stays on until [A-Z][a-z]{2} \d{1,2}, \d{4}\. After that you pay per video\./);
    fireEvent.click(within(notice).getByRole("button", { name: "Keep Business" }));
    await waitFor(() => expect(mockDb.billing.plan?.scheduled_change).toBeNull());
  });

  it("Studio checks out yearly, renews a year out, and Billing says when usage resets", async () => {
    renderPricing();
    const studio = await screen.findByTestId("plan-studio");
    fireEvent.click(await within(studio).findByTestId("choose-studio"));
    const main = await screen.findByTestId("plan-main");
    expect(main.textContent).toContain("Start Studio · $11,988.00 a year");
    const sheet = screen.getByTestId("plan-sheet");
    const year = String(new Date().getFullYear() + 1);
    expect(sheet.textContent).toMatch(new RegExp(`Billed yearly\\. Renews on \\d+ \\w+ ${year} until you cancel\\.`));
    await waitFor(() => expect((screen.getByTestId("plan-main") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("plan-main"));
    expect(await screen.findByText("Studio is on. $1,500 of usage is ready.")).toBeTruthy();
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
    expect(within(card).getByTestId("plan-price").textContent).toBe("$11,988.00 a year");
    expect(within(card).getByTestId("plan-credit-resets").textContent).toMatch(/^Usage resets on \d+ \w+ \d{4}\.$/);
    expect(card.textContent).toMatch(new RegExp(`Billed yearly\\. Renews on \\d+ \\w+ ${year}\\.`));
  });

  it("plan cards take the top frame rate from /v1/pricing fps when the plan omits it", () => {
    expect(
      planLines(
        { name: "Business", monthly_cents: 29900, credit_cents: 40000, max_active_runs: 3, free_previews_per_period: 50, express_included: true },
        0.2,
        120,
      ),
    ).toContain("Up to 120 fps");
  });

  it("plan card lines", () => {
    expect(
      planLines(
        { name: "Studio", monthly_cents: 99900, credit_cents: 150000, max_active_runs: 8, free_previews_per_period: 200, express_included: true, max_fps: 120 },
        0.25,
      ),
    ).toEqual(["$1,500 of usage every month", "25% off every run", "Commercial use of your videos", "200 free previews a month", "Express included", "Up to 120 fps", "Invoices"]);
  });
});
