/**
 * Plans and paywalls, the starting set (plans canvas, 2026-11-04): who sees
 * which surface, dismissals kept on the account, prices from the quote and
 * the tier rates, and pay once as the default.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LifelikeDeliverPanel } from "@/components/steps/LifelikeDeliverPanel";
import type { Project, StepQuoteResponse } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { resetProForTests } from "@/lib/pro/usePro";
import { resetAccountSettingsCache } from "@/lib/useAccountSettings";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { HeaderPlans } from "./HeaderPlans";
import { PlansBanner } from "./PlansBanner";
import { ProSavingsCard } from "./ProSavingsCard";
import { isCompanyEmail, isDismissed, saveRange, tierPriceFor } from "./upsell";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));
vi.mock("@/components/steps/polling", () => ({ POLL_INTERVAL_MS: 30 }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  resetAccountSettingsCache();
  resetPricingCache();
  resetProForTests();
  mockDb.tierPricing = true;
  mockDb.accountSettings.hints_seen = [];
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const wrap = (el: React.ReactElement) =>
  render(
    <AuthProvider>
      <BillingProvider>{el}</BillingProvider>
    </AuthProvider>,
  );

function business(): void {
  mockDb.billing.plan = {
    plan: "business", name: "Business", status: "active", active: true, monthly_cents: 29900,
    credit_cents: 40000, credit_left_cents: 40000, cancel_at_period_end: false,
  };
}

describe("pure rules", () => {
  it("the save range comes from the tier shares", () => {
    expect(saveRange({ tiers: { classic_pct: { pro: 0.15, business: 0.2, studio: 0.25 } } } as never)).toBe("15–25%");
    expect(saveRange(null)).toBeNull();
  });

  it("dated dismissals come back after their days", () => {
    const now = new Date(Date.UTC(2026, 10, 12));
    expect(isDismissed("2026-11-04T09:00:00Z", 7, now)).toBe(false);
    expect(isDismissed("2026-11-08T09:00:00Z", 7, now)).toBe(true);
    expect(isDismissed("2026-01-01T00:00:00Z", null, now)).toBe(true);
    expect(isDismissed(undefined, 7, now)).toBe(false);
  });

  it("company email domains", () => {
    expect(isCompanyEmail("maya@northlight-films.com")).toBe(true);
    for (const e of ["a@gmail.com", "b@outlook.com", "c@icloud.com", "d@yahoo.co.jp", "e@qq.com", "f@163.com"]) {
      expect(isCompanyEmail(e)).toBe(false);
    }
  });

  it("a Pro price from the quote and the tier rates", () => {
    const quote = {
      step: "production",
      params: { preset: "4k", formats: ["mvhevc"] },
      quote: { amount_cents: 3000, currency: "usd", breakdown: { preset: "4k", billable_minutes: 3, fps_factor: 1, subtotal_cents: 3000, addons: {} } },
    } as unknown as StepQuoteResponse;
    const pricing = {
      tiers: { order: [], classic_pct: {}, lifelike_cents_per_minute: { pro: { "4k": 850 }, business: { "4k": 800 } } },
      discount: { threshold_cents: 5000, pct: 0.1 },
      minimum_cents: 100,
    } as never;
    expect(tierPriceFor(quote, pricing, "pro")).toBe(2550);
    expect(tierPriceFor(quote, pricing, "business")).toBe(2400);
    expect(tierPriceFor({ ...quote, step: "lifelike_preview" } as StepQuoteResponse, pricing, "pro")).toBeNull();
  });
});

describe("header B", () => {
  it("shows Plans with the save chip to people without a plan", async () => {
    wrap(<HeaderPlans />);
    expect((await screen.findByTestId("header-save-chip")).textContent).toBe("Save 15–25%");
    expect(screen.getByTestId("header-plans").getAttribute("href")).toBe("/plans");
  });

  it("drops the chip with a plan", async () => {
    business();
    wrap(<HeaderPlans />);
    await waitFor(() => expect(screen.getByTestId("header-plans")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByTestId("header-save-chip")).toBeNull();
  });
});

describe("projects A", () => {
  it("dismisses to one line, kept on the account", async () => {
    wrap(<PlansBanner />);
    expect((await screen.findByTestId("plans-banner")).textContent).toContain("Pro takes 15% off every video.");
    fireEvent.click(screen.getByTestId("plans-banner-dismiss"));
    expect(await screen.findByTestId("plans-line")).toBeTruthy();
    await waitFor(() => expect(mockDb.accountSettings.dismissed.projects_banner).toMatch(/^\d{4}-\d{2}-\d{2}T/));
  });

  it("isn't shown with a plan", async () => {
    business();
    wrap(<PlansBanner />);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("plans-banner")).toBeNull();
    expect(screen.queryByTestId("plans-line")).toBeNull();
  });
});

describe("quote A and the Business note", () => {
  function project(): Project {
    const p = mockDb.projects.get((projectFixture as unknown as Project).project_id)!;
    p.method = "lifelike";
    return structuredClone({ ...p, conversions: [] });
  }

  it("pay once is selected; With Pro turns the button into Subscribe and convert; nothing is charged", async () => {
    wrap(<LifelikeDeliverPanel project={project()} onProjectChanged={() => {}} />);
    const once = await screen.findByTestId("pay-once", undefined, { timeout: 4000 });
    expect(once.getAttribute("aria-checked")).toBe("true");
    const main = screen.getByTestId("checkout-main");
    expect(main.textContent).toMatch(/^Make 3D · \$/);
    fireEvent.click(screen.getByTestId("pay-with-pro"));
    expect(screen.getByTestId("checkout-main").textContent).toBe("Subscribe and convert");
    const before = mockDb.conversions.size;
    fireEvent.click(screen.getByTestId("checkout-main"));
    expect(await screen.findByTestId("pro-checkout")).toBeTruthy();
    expect(mockDb.conversions.size).toBe(before);
    fireEvent.click(screen.getByTestId("pro-checkout-pay-once"));
    await waitFor(() => expect(screen.getByTestId("checkout-main").textContent).toMatch(/^Make 3D · \$/));
  });

  it("a $50+ quote carries the Business note", async () => {
    const p = project();
    p.probe = { ...p.probe!, duration_s: 600, num_frames: Math.round(600 * p.probe!.fps) };
    mockDb.projects.get(p.project_id)!.probe = p.probe;
    wrap(<LifelikeDeliverPanel project={p} onProjectChanged={() => {}} />);
    const note = await screen.findByTestId("business-note", undefined, { timeout: 4000 });
    expect(note.textContent).toContain("Business and Studio include monthly usage.");
    expect(note.textContent).toMatch(/At Business prices this video is \$/);
  });
});

describe("receipt A", () => {
  it("names what Pro would have saved on a billed run", async () => {
    const p = mockDb.projects.get((projectFixture as unknown as Project).project_id)!;
    const run = {
      conversion_id: "billed1",
      project_id: p.project_id,
      step: "production",
      method: "lifelike",
      state: "succeeded",
      params: { preset: "4k", formats: ["mvhevc"] },
      quote: { amount_cents: 3000, currency: "usd", breakdown: { preset: "4k", billable_minutes: 3, fps_factor: 1, subtotal_cents: 3000, addons: {} } },
      billing: { status: "charged" },
      created_at: new Date().toISOString(),
    };
    wrap(<ProSavingsCard project={{ ...p, conversions: [run] } as unknown as Project} />);
    expect((await screen.findByTestId("receipt-pro")).textContent).toContain("You'd have saved $4.50 with Pro");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByTestId("receipt-pro")).toBeNull());
  });
});
