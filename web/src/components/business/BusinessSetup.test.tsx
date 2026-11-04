/**
 * Business and Studio setup (owner 2026-11-04): numbers from /v1/pricing,
 * no seat counts, no company step (Checkout collects it), skippable questions,
 * the Pro slot per case, nothing charged before confirming, the funnel
 * events.
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

import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { resetProForTests } from "@/lib/pro/usePro";
import { resetAccountSettingsCache } from "@/lib/useAccountSettings";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { APP_STORE_PRO_NOTE, BusinessSetup } from "./BusinessSetup";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/account/business",
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  resetAccountSettingsCache();
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

function renderSetup() {
  render(
    <AuthProvider>
      <BillingProvider>
        <BusinessSetup />
      </BillingProvider>
    </AuthProvider>,
  );
}

const names = () => mockDb.events.map((e) => e.name);

async function toCheckout(): Promise<void> {
  renderSetup();
  fireEvent.click(await screen.findByTestId("setup-next"));
  fireEvent.click(await screen.findByTestId("setup-skip"));
  await screen.findByTestId("setup-checkout");
}

describe("Business and Studio setup", () => {
  it("plans from /v1/pricing, frame rates up to 120 fps, no seat counts", async () => {
    renderSetup();
    const business = await screen.findByTestId("setup-plan-business");
    expect(business.textContent).toContain("$299 a month");
    expect(business.textContent).toContain("20% off every video");
    expect(business.textContent).toContain("$400 of usage every month");
    expect(business.textContent).toContain("Frame rates up to 120 fps");
    const studio = screen.getByTestId("setup-plan-studio");
    expect(studio.textContent).toContain("$11,988 a year");
    expect(studio.textContent).toContain("25% off every video");
    expect(document.body.textContent).not.toMatch(
      /\bpeople\b|\bseats?\b|60 fps/i,
    );
    await waitFor(() => expect(names()).toContain("business_setup_opened"));
  });

  it("plan, then the optional questions, then checkout; no company step", async () => {
    renderSetup();
    fireEvent.click(await screen.findByTestId("setup-plan-studio"));
    fireEvent.click(screen.getByTestId("setup-next"));
    expect(await screen.findByTestId("setup-questions")).toBeTruthy();
    expect(screen.queryByTestId("setup-details")).toBeNull();
    expect(screen.getByRole("list", { name: "Steps" }).textContent).toBe(
      "1. Plan2. About you3. Pay",
    );
    await waitFor(() =>
      expect(
        mockDb.events.find((e) => e.name === "business_setup_plan_picked")
          ?.props,
      ).toEqual({ plan: "studio" }),
    );
  });

  it("the answers are saved on the account; the funnel event carries none", async () => {
    renderSetup();
    fireEvent.click(await screen.findByTestId("setup-next"));
    fireEvent.change(await screen.findByTestId("setup-team-size"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Client work" }));
    fireEvent.click(screen.getByTestId("setup-headset-avp"));
    fireEvent.click(screen.getByTestId("setup-next"));
    await screen.findByTestId("setup-checkout");
    await waitFor(() =>
      expect(mockDb.accountSettings.business_setup).toEqual({
        team_size: "4",
        main_use: "client_work",
        headsets: ["avp"],
      }),
    );
    await waitFor(() =>
      expect(
        mockDb.events.find((e) => e.name === "business_setup_details_done")
          ?.props,
      ).toEqual({}),
    );
  });

  it("no Pro: the price and terms, then the plan sheet; nothing charged before", async () => {
    await toCheckout();
    expect(screen.getByTestId("setup-terms").textContent).toContain(
      "Billed monthly. Renews every month until you cancel.",
    );
    expect(screen.queryByTestId("setup-pro-slot")).toBeNull();
    await waitFor(() =>
      expect(names()).toContain("business_setup_details_done"),
    );
    fireEvent.click(screen.getByTestId("setup-pay"));
    await waitFor(() =>
      expect(
        mockDb.events.find((e) => e.name === "business_setup_checkout_started")
          ?.props,
      ).toEqual({ plan: "business" }),
    );
    expect(mockDb.billing.plan).toBeFalsy();
  });

  it("web Pro: today's price from the preview, then the change on confirm, then the welcome", async () => {
    mockDb.proStatus = { pro: true, known: true, source: "stripe" };
    await toCheckout();
    const preview = await screen.findByTestId("setup-preview-line");
    expect(preview.textContent).toBe(
      "Today: $294.50. Business $299.00 − $4.50 for your unused Pro.",
    );
    expect(mockDb.planChanges).toEqual([]);
    fireEvent.click(screen.getByTestId("setup-confirm"));
    expect(await screen.findByTestId("setup-welcome")).toBeTruthy();
    expect(screen.getByTestId("setup-company-link").getAttribute("href")).toBe(
      "/account/business-details",
    );
    expect(mockDb.planChanges).toEqual(["business"]);
    await waitFor(() => expect(names()).toContain("business_setup_purchased"));
    expect(
      screen
        .getByRole("link", { name: "Make your 3D video" })
        .getAttribute("href"),
    ).toBe("/projects");
    expect(screen.queryByText(APP_STORE_PRO_NOTE)).toBeNull();
  });

  it("App Store Pro: Apple's note and the manage button before paying", async () => {
    mockDb.proStatus = {
      pro: true,
      known: true,
      source: "app_store",
      management_url: "https://apps.apple.com/account/subscriptions",
    };
    await toCheckout();
    const slot = await screen.findByTestId("setup-pro-slot");
    expect(slot.textContent).toContain(APP_STORE_PRO_NOTE);
    expect(
      screen
        .getByRole("link", { name: "Manage App Store subscription" })
        .getAttribute("href"),
    ).toBe("https://apps.apple.com/account/subscriptions");
  });

  it("Pro included with a plan or simulated: no note", async () => {
    mockDb.proStatus = { pro: true, known: true, source: "simulated" };
    await toCheckout();
    expect(screen.queryByTestId("setup-pro-slot")).toBeNull();
  });

  it("a Business holder moves up to Studio; the preview prices it", async () => {
    mockDb.billing.plan = {
      plan: "business",
      name: "Business",
      status: "active",
      active: true,
      monthly_cents: 29900,
      credit_cents: 40000,
      credit_left_cents: 5000,
      cancel_at_period_end: false,
      current_period_end: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    };
    await toCheckout();
    expect(screen.getByTestId("setup-pro-slot").textContent).toContain(
      "What happens to your Business",
    );
    const line = await screen.findByTestId("setup-preview-line");
    expect(line.textContent).toBe(
      "Today: $11,950.62. Studio $11,988.00 − $37.38 for your unused Business.",
    );
    expect(screen.getByTestId("setup-preview").textContent).toContain(
      "Your remaining Business usage this month ends when Studio's $1,500 starts.",
    );
    fireEvent.click(screen.getByTestId("setup-confirm"));
    expect(await screen.findByTestId("setup-welcome")).toBeTruthy();
    expect(mockDb.billing.plan?.plan).toBe("studio");
  });
});
