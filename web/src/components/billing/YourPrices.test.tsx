/**
 * Plan & billing → Your prices per minute (owner 2026-11-07): the /pricing
 * table for the account's plan and the next plan up with its upgrade, by
 * the server's price order. Every figure from the pricing mock (GET
 * /v1/pricing, tiers.lifelike_cents_per_minute).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { formatCents } from "@/components/steps/money";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { nextPlanUp, YourPrices } from "./YourPrices";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/account/billing",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  resetPricingCache();
  mockDb.tierPricing = true;
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  delete (globalThis as { __mockDb?: typeof mockDb }).__mockDb;
});
afterAll(() => server.close());

/** The pricing mock's own column for a plan, read from the route. */
async function column(plan: "list" | "pro" | "business" | "studio"): Promise<Record<string, number>> {
  const r = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787"}/v1/pricing`);
  const p = (await r.json()) as { tiers: { lifelike_cents_per_minute: Record<string, Record<string, number>> } };
  return p.tiers.lifelike_cents_per_minute[plan];
}

function renderPrices(): void {
  render(
    <AuthProvider>
      <BillingProvider>
        <YourPrices />
      </BillingProvider>
    </AuthProvider>,
  );
}

function team(plan: "business" | "studio", extra: Record<string, unknown> = {}): void {
  mockDb.billing.plan = {
    plan,
    name: plan === "studio" ? "Studio" : "Business",
    status: "active",
    active: true,
    monthly_cents: plan === "studio" ? 99900 : 29900,
    credit_cents: 40000,
    credit_left_cents: 40000,
    cancel_at_period_end: false,
    current_period_end: "2026-12-05T12:00:00Z",
    interval: plan === "studio" ? "year" : "month",
    price_cents: plan === "studio" ? 1198800 : 29900,
    ...extra,
  } as never;
}

function webPro(): void {
  mockDb.billing.plan = {
    plan: "pro", plan_id: "pro_monthly", name: "Pro Monthly", status: "active", active: true, monthly_cents: 899,
    cancel_at_period_end: false, current_period_end: "2026-12-05T12:00:00Z",
  } as never;
  mockDb.proStatus = { pro: true, known: true, source: "plan", plan_id: "pro_monthly", via: "pro_monthly", scheduled_change: null };
  (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
}

describe("the ladder", () => {
  it("follows the server's price order, Studio at the top", () => {
    const order = ["studio", "business", "pro", "list"];
    expect(nextPlanUp("list", order)).toBe("pro");
    expect(nextPlanUp("pro", order)).toBe("business");
    expect(nextPlanUp("business", order)).toBe("studio");
    expect(nextPlanUp("studio", order)).toBeNull();
  });
});

describe("Your prices per minute", () => {
  it("no plan: the list prices, and Pro beside them with Upgrade to Pro", async () => {
    const list = await column("list");
    const pro = await column("pro");
    renderPrices();
    const mine = await screen.findByTestId("your-prices-mine");
    expect(mine.textContent).toContain("Pay per video");
    expect(within(mine).getByTestId("price-4k").textContent).toBe(formatCents(list["4k"]));
    expect(within(mine).queryByTestId("list-4k")).toBeNull();
    const next = screen.getByTestId("your-prices-next");
    expect(next.textContent).toContain("With Pro");
    expect(next.textContent).toContain("15% off every minute");
    expect(within(next).getByTestId("price-4k").textContent).toBe(`${formatCents(list["4k"])}${formatCents(pro["4k"])}`);
    expect(within(next).getByTestId("list-4k").className).toMatch(/line-through/);
    expect(await within(next).findByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
  });

  it("web Pro: Pro's prices (list struck through), and Business beside them", async () => {
    webPro();
    const pro = await column("pro");
    renderPrices();
    const mine = await screen.findByTestId("your-prices-mine");
    await waitFor(() => expect(mine.textContent).toContain("With Pro, 15% off"));
    expect(within(mine).getByTestId("price-1080p").textContent).toContain(formatCents(pro["1080p"]));
    const next = screen.getByTestId("your-prices-next");
    expect(next.textContent).toContain("With Business");
    fireEvent.click(within(next).getByRole("button", { name: "Upgrade to Business" }));
    // a web Pro moves by plan change, credited for the unused Pro
    expect(await screen.findByTestId("plan-change-sheet")).toBeTruthy();
  });

  it("Business: its prices, and Studio beside them", async () => {
    team("business");
    const biz = await column("business");
    renderPrices();
    const mine = await screen.findByTestId("your-prices-mine");
    await waitFor(() => expect(mine.textContent).toContain("With Business, 20% off"));
    expect(within(mine).getByTestId("price-8k").textContent).toContain(formatCents(biz["8k"]));
    const next = screen.getByTestId("your-prices-next");
    expect(next.textContent).toContain("With Studio");
    expect(within(next).getByRole("button", { name: "Upgrade to Studio" })).toBeTruthy();
  });

  it("Studio: its prices, nothing above", async () => {
    team("studio");
    renderPrices();
    const mine = await screen.findByTestId("your-prices-mine");
    await waitFor(() => expect(mine.textContent).toContain("With Studio, 25% off"));
    expect(screen.queryByTestId("your-prices-next")).toBeNull();
  });

  it("a restored plan sees Studio's prices but no upgrade (its changes are refused)", async () => {
    team("business", { cancel_at_period_end: true, renewable: false, restored_from: "old" });
    renderPrices();
    const next = await screen.findByTestId("your-prices-next");
    await waitFor(() => expect(next.textContent).toContain("With Studio"));
    expect(within(next).queryByRole("button")).toBeNull();
  });

  it("App Store Pro: Business through the Business setup", async () => {
    mockDb.proStatus = { pro: true, known: true, source: "app_store", scheduled_change: null };
    (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
    renderPrices();
    const next = await screen.findByTestId("your-prices-next");
    await waitFor(() => expect(next.textContent).toContain("With Business"));
    expect(within(next).getByRole("link", { name: "Upgrade to Business" }).getAttribute("href")).toBe("/account/business");
  });

  it("folds away and opens again", async () => {
    renderPrices();
    await screen.findByTestId("your-prices-mine");
    fireEvent.click(screen.getByRole("button", { name: "Your prices per minute" }));
    await waitFor(() => expect(screen.queryByTestId("your-prices-mine")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Your prices per minute" }));
    expect(await screen.findByTestId("your-prices-mine")).toBeTruthy();
  });
});
