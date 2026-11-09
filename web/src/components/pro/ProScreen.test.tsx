import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ProCheckoutHost } from "@/components/pro/ProCheckoutHost";
import { ProScreen } from "@/components/pro/ProScreen";
import { stepCheckoutAtom } from "@/components/steps/checkoutStore";
import type { StepQuoteResponse } from "@/lib/api/types";
import { QuoteView } from "@/components/steps/QuoteView";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb, MOCK_PRO_CREDIT, MOCK_PRO_PLANS } from "@/mocks/handlers";
import { resetProForTests, useProOffer } from "@/lib/pro/usePro";
import { server } from "@/mocks/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/pro",
  useSearchParams: () => new URLSearchParams("next=/projects/abc123abc123"),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetProForTests();
  mockDb.reset();
});
afterAll(() => server.close());

function Offer() {
  const offer = useProOffer();
  return <p data-testid="offer">{offer?.line ?? "none"}</p>;
}

describe("/pro (mock mode)", () => {
  it("shows the plans, Yearly first and chosen as Best value (owner 2026-11-07, BUX-10)", async () => {
    render(
      <AuthProvider>
        <ProScreen />
      </AuthProvider>,
    );
    expect(await screen.findByTestId("pro-plans")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/% off every 3D video$/);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("data-testid"))).toEqual(["pro-plan-yearly", "pro-plan-monthly", "pro-plan-weekly"]);
    expect(screen.getByTestId("pro-plan-yearly").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("pro-plan-best-yearly").textContent).toBe("Best value");
    expect(screen.queryByTestId("pro-plan-best-weekly")).toBeNull();
    // per-month equivalents beside the plans that aren't monthly
    expect(screen.getByTestId("pro-plan-per-month-yearly").textContent).toBe("$4.17 a month");
    expect(screen.getByTestId("pro-plan-per-month-weekly").textContent).toBe("$17.29 a month");
    expect(screen.queryByTestId("pro-plan-per-month-monthly")).toBeNull();
    expect(screen.getByText("Renews at $49.99 a year until you cancel. Cancel any time in Plan & billing.")).toBeTruthy();
    const weekly = screen.getByTestId("pro-plan-weekly");
    expect(weekly.getAttribute("aria-checked")).toBe("false");
    // owner 2026-11-07: no intro offers; the monthly credit instead
    expect(weekly.textContent).toContain("$3.99");
    expect(weekly.textContent).not.toMatch(/for 4 weeks|first year/);
    expect(screen.getByTestId("pro-plan-credit-weekly").textContent).toBe("+ $20 credit to start");
    expect(screen.getByRole("heading", { level: 1 }).nextElementSibling?.textContent).toBe(
      "Plus $20 of usage credit when you join Pro (or the first time you sign in here with Pro from the app), and Pro in the app on iPhone, iPad, Mac and Vision Pro.",
    );
    expect(screen.getByTestId("pro-credit-rules").textContent).toBe(
      "Use it within 30 days.",
    );
    expect(screen.getByTestId("pro-plan-yearly").textContent).toContain("Save 17%");
    // Weekly, Monthly and Yearly only: no pass, no Lifetime (owner, 2026-11-03)
    expect(screen.queryByTestId("pro-plan-pass")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Lifetime|3 months|Doesn't renew/);
  });

  it("buys, says welcome, links back to the video and drops stale quotes", async () => {
    const store = getDefaultStore();
    const a = stepCheckoutAtom("abc123abc123", "stereo_preview", "lifelike");
    store.set(a, {
      quote: { quote: { amount_cents: 850 } } as unknown as StepQuoteResponse,
      attemptKey: "k",
      active: null,
      settled: false,
    });
    (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
    render(
      <AuthProvider>
        <ProScreen />
        <ProCheckoutHost />
      </AuthProvider>,
    );
    fireEvent.click(await screen.findByTestId("pro-get"));
    // gateway 00102: our own payment sheet, nothing charged before Start Pro
    await waitFor(() =>
      expect(
        (screen.getByTestId("pro-stripe-pay") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId("pro-stripe-pay"));
    expect(
      await screen.findByTestId("pro-member", undefined, { timeout: 5000 }),
    ).toBeTruthy();
    delete (globalThis as { __mockDb?: typeof mockDb }).__mockDb;
    expect(screen.getByText("Welcome to Pro")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to your video" }).getAttribute("href")).toBe(
      "/projects/abc123abc123",
    );
    await waitFor(() => expect(store.get(a).quote).toBeNull());
    expect(store.get(a).attemptKey).toBeNull();
  });

  it("the credit's amount comes from /v1/pricing, never the page (owner 2026-11-07)", async () => {
    const saved = { cents: MOCK_PRO_CREDIT.cents, plans: MOCK_PRO_PLANS.map((p) => p.credit_cents) };
    MOCK_PRO_CREDIT.cents = 1500;
    for (const p of MOCK_PRO_PLANS) p.credit_cents = 1500;
    try {
      render(
        <AuthProvider>
          <ProScreen />
        </AuthProvider>,
      );
      expect(await screen.findByTestId("pro-plan-credit-monthly")).toBeTruthy();
      expect(screen.getByTestId("pro-plan-credit-monthly").textContent).toBe("+ $15 credit to start");
      await waitFor(() =>
        expect(screen.getByRole("heading", { level: 1 }).nextElementSibling?.textContent).toContain(
          "$15 of usage credit when you join Pro",
        ),
      );
    } finally {
      MOCK_PRO_CREDIT.cents = saved.cents;
      MOCK_PRO_PLANS.forEach((p, i) => (p.credit_cents = saved.plans[i]));
    }
  });

  it("a member sees the credit left and its use-by day", async () => {
    mockDb.pro = true;
    // mock mode reads Pro from the browser mock's state
    (globalThis as { __mockDb?: unknown }).__mockDb = {
      proStatus: { pro: true, known: true, source: "app_store", via: "pro_monthly" },
    };
    mockDb.proCredit = {
      cents: 2000,
      kind: "pro_monthly",
      source: "app_store",
      trial: false,
      granted_at: "2099-11-01T00:00:00Z",
      expires_at: "2099-12-01T00:00:00Z",
      granted: true,
      left_cents: 800,
    };
    render(
      <AuthProvider>
        <BillingProvider>
          <ProScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    try {
      expect((await screen.findByTestId("pro-credit-left")).textContent).toBe("$8.00 of $20.00 Pro credit left · use by 1 Dec");
    } finally {
      delete (globalThis as { __mockDb?: unknown }).__mockDb;
    }
  });

  it("useProOffer anchors on Monthly for the quote's sheet", async () => {
    render(
      <AuthProvider>
        <Offer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("offer").textContent).toBe("$4.99 a month"));
  });
});

describe("Business and Studio include Pro (owner, 2026-11)", () => {
  afterEach(() => mockDb.reset());

  it("/pro says it's included and links to Billing; no plans for sale", async () => {
    mockDb.billing.plan = {
      plan: "studio", name: "Studio", status: "active", active: true, monthly_cents: 99900,
      credit_cents: 150000, credit_left_cents: 150000, cancel_at_period_end: false,
    };
    render(
      <AuthProvider>
        <BillingProvider>
          <ProScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    const box = await screen.findByTestId("pro-included");
    expect(box.textContent).toContain("Pro is included in your Studio plan.");
    expect(screen.getByRole("link", { name: "Billing" }).getAttribute("href")).toBe("/account/billing");
    expect(screen.queryByTestId("pro-plans")).toBeNull();
  });

  it("a plan's quote has its own line and no Pro upsell", async () => {
    render(
      <AuthProvider>
        <QuoteView
          result={{
            step: "production",
            method: "lifelike",
            params: { preset: "4k", formats: ["mvhevc"] },
            tier: "business",
            tier_label: "Business",
            pro: false,
            discount: { kind: "tier", tier: "business", cents: 400, pct: 0.2 },
            quote: {
              amount_cents: 1600,
              currency: "usd",
              breakdown: { subtotal_cents: 2000, list_base_cents: 2000, addons: {}, discount: { kind: "tier", tier: "business", cents: 400, pct: 0.2 } },
            },
            reuse_stages: null,
          }}
        />
      </AuthProvider>,
    );
    expect(screen.getByText("Business price")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("pro-save-link")).toBeNull();
  });
});

describe("/pro with Weekly hidden on the web (BUX-24 proposal)", () => {
  it("off (the default, mock included): Weekly is there", async () => {
    expect(mockDb.webProWeeklyHidden).toBe(false);
    render(
      <AuthProvider>
        <ProScreen />
      </AuthProvider>,
    );
    expect(await screen.findByTestId("pro-plan-weekly")).toBeTruthy();
  });

  it("on: Monthly and Yearly only", async () => {
    mockDb.webProWeeklyHidden = true;
    render(
      <AuthProvider>
        <ProScreen />
      </AuthProvider>,
    );
    expect(await screen.findByTestId("pro-plan-yearly")).toBeTruthy();
    expect(screen.queryByTestId("pro-plan-weekly")).toBeNull();
    expect(screen.getByTestId("pro-plan-monthly")).toBeTruthy();
  });
});
