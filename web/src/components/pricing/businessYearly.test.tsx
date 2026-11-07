/**
 * BUX-25 (proposal): Business billed yearly at 10× its month, behind GET
 * /v1/pricing business_yearly, off by default (the mock too). Monthly
 * stays first; Yearly shows the month it comes to, the yearly charge and
 * the saving, and pays in the same sheet.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { resetProForTests } from "@/lib/pro/usePro";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { PricingScreen } from "./PricingScreen";
import { yearlySavePct } from "./PlansSection";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pricing",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));

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

function renderPricing(): void {
  render(
    <AuthProvider>
      <BillingProvider>
        <PricingScreen />
      </BillingProvider>
    </AuthProvider>,
  );
}

describe("Business yearly (BUX-25, gateway a7d7c2e)", () => {
  it("10× the month saves 17%", () => {
    const m = { name: "Business", monthly_cents: 29900, credit_cents: 0, max_active_runs: 1, free_previews_per_period: 0, express_included: false, interval: "month" as const, price_cents: 29900 };
    expect(yearlySavePct({ ...m, interval: "year", price_cents: 299000 }, m)).toBe(17);
    expect(yearlySavePct({ ...m, interval: "year", price_cents: 358800 }, m)).toBeNull();
  });

  it("off by default (the mock too): Business bills monthly only", async () => {
    expect(mockDb.businessYearly).toBe(false);
    renderPricing();
    const biz = await screen.findByTestId("plan-business");
    expect(within(biz).queryByTestId("business-period")).toBeNull();
    expect(screen.getByTestId("plan-price-business").textContent).toBe("$299 a month");
  });

  it("on: Monthly first; Yearly shows the month, the yearly charge and the saving, and pays yearly", async () => {
    mockDb.businessYearly = true;
    renderPricing();
    const biz = await screen.findByTestId("plan-business");
    const monthly = await within(biz).findByTestId("business-monthly");
    expect(monthly.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("plan-price-business").textContent).toBe("$299 a month");
    const yearly = within(biz).getByTestId("business-yearly");
    expect(yearly.textContent).toBe("Yearly · save 17%");
    fireEvent.click(yearly);
    expect(screen.getByTestId("plan-price-business").textContent).toBe("$249.17 a month");
    expect(screen.getByTestId("plan-billed-business").textContent).toBe("billed yearly ($2,990)");
    fireEvent.click(within(biz).getByTestId("choose-business"));
    const main = await screen.findByTestId("plan-main");
    await waitFor(() => expect((screen.getByTestId("plan-main") as HTMLButtonElement).disabled).toBe(false));
    expect(main.textContent).toContain("$2,990.00");
    fireEvent.click(main);
    await waitFor(() => expect(mockDb.billing.plan).toMatchObject({ plan: "business", plan_id: "business_yearly", interval: "year", price_cents: 299000 }));
  });

  it("turned off after the page loaded: 409 plan_unavailable says so, reads the prices again and drops Yearly", async () => {
    mockDb.businessYearly = true;
    let reads = 0;
    server.events.on("request:start", ({ request }) => {
      if (request.method === "GET" && new URL(request.url).pathname === "/v1/pricing") reads += 1;
    });
    renderPricing();
    const biz = await screen.findByTestId("plan-business");
    fireEvent.click(await within(biz).findByTestId("business-yearly"));
    mockDb.businessYearly = false;
    const before = reads;
    fireEvent.click(within(biz).getByTestId("choose-business"));
    expect(await screen.findByText("That plan isn't offered right now. Choose another one.")).toBeTruthy();
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    await waitFor(() => expect(within(screen.getByTestId("plan-business")).queryByTestId("business-yearly")).toBeNull());
    expect(mockDb.billing.plan).toBeFalsy();
  });
});
