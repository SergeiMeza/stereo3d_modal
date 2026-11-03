import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ProScreen } from "@/components/pro/ProScreen";
import { stepCheckoutAtom } from "@/components/steps/checkoutStore";
import type { StepQuoteResponse } from "@/lib/api/types";
import { QuoteView } from "@/components/steps/QuoteView";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
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
});
afterAll(() => server.close());

function Offer() {
  const offer = useProOffer();
  return <p data-testid="offer">{offer?.line ?? "none"}</p>;
}

describe("/pro (mock mode)", () => {
  it("shows the plans, Weekly first and chosen", async () => {
    render(
      <AuthProvider>
        <ProScreen />
      </AuthProvider>,
    );
    expect(await screen.findByTestId("pro-plans")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/% off every 3D video$/);
    const weekly = screen.getByTestId("pro-plan-weekly");
    expect(weekly.getAttribute("aria-checked")).toBe("true");
    expect(weekly.textContent).toContain("$3.99 / week for 4 weeks");
    expect(screen.getByTestId("pro-plan-yearly").textContent).toContain("Save 26%");
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
    render(
      <AuthProvider>
        <ProScreen />
      </AuthProvider>,
    );
    fireEvent.click(await screen.findByTestId("pro-get"));
    expect(await screen.findByTestId("pro-member")).toBeTruthy();
    expect(screen.getByText("Welcome to Pro")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to your video" }).getAttribute("href")).toBe(
      "/projects/abc123abc123",
    );
    await waitFor(() => expect(store.get(a).quote).toBeNull());
    expect(store.get(a).attemptKey).toBeNull();
  });

  it("useProOffer anchors on Monthly for the quote's sheet", async () => {
    render(
      <AuthProvider>
        <Offer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("offer").textContent).toBe("$8.99 a month"));
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
            discount: { kind: "tier", tier: "business", cents: 500, pct: 0.25 },
            quote: {
              amount_cents: 1500,
              currency: "usd",
              breakdown: { subtotal_cents: 2000, list_base_cents: 2000, addons: {}, discount: { kind: "tier", tier: "business", cents: 500, pct: 0.25 } },
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
