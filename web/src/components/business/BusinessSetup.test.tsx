/**
 * Business and Studio setup (owner 2026-11-04): numbers from /v1/pricing,
 * no seat counts, company details before checkout, skippable questions,
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
  mockDb.billing.company = {
    name: "Northlight Films",
    address: { country: "GB", city: "London" },
    tax_ids: [],
  };
  renderSetup();
  fireEvent.click(await screen.findByTestId("setup-next"));
  await screen.findByTestId("setup-details");
  await waitFor(() =>
    expect(screen.getByTestId("setup-company-summary").textContent).toContain(
      "Northlight Films",
    ),
  );
  fireEvent.click(screen.getByTestId("setup-next"));
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

  it("company details come before the questions; the questions can be skipped", async () => {
    renderSetup();
    fireEvent.click(await screen.findByTestId("setup-plan-studio"));
    fireEvent.click(screen.getByTestId("setup-next"));
    await screen.findByTestId("setup-details");
    await waitFor(() =>
      expect(screen.getByTestId("setup-company-summary").textContent).toBe(
        "No company details yet.",
      ),
    );
    expect(
      (screen.getByTestId("setup-next") as HTMLButtonElement).disabled,
    ).toBe(true);
    await waitFor(() =>
      expect(
        mockDb.events.find((e) => e.name === "business_setup_plan_picked")
          ?.props,
      ).toEqual({ plan: "studio" }),
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
    const preview = await screen.findByTestId("setup-preview");
    expect(preview.textContent).toMatch(
      /^Today: \$294\.50 \(new plan \$299\.00 − \$4\.50 for your unused Pro days\)\. Renews on /,
    );
    expect(mockDb.planChanges).toEqual([]);
    fireEvent.click(screen.getByTestId("setup-confirm"));
    expect(await screen.findByTestId("setup-welcome")).toBeTruthy();
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
});
