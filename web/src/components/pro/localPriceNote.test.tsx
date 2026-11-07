/**
 * Owner 2026-11-07 (Option B): Pro shows its US dollar prices and, while
 * GET /v1/pricing says adaptive_pricing, "You'll see your local price at
 * checkout." beside them — on /pro, the plans sheet and the plans intro —
 * and the Pro payment sheet says it instead of "Charged in US dollars.".
 * Off, everything reads as before.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PayPerVideoAndPro } from "@/components/plans/PlansIntro";
import { PlansSheet } from "@/components/plans/PlansSheet";
import { ProCheckoutHost } from "@/components/pro/ProCheckoutHost";
import { ProScreen } from "@/components/pro/ProScreen";
import type { PublicPricing } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { resetProForTests } from "@/lib/pro/usePro";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/pro",
  useSearchParams: () => new URLSearchParams(),
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const LOCAL = "You'll see your local price at checkout.";
const USD = "Charged in US dollars.";
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => resetPricingCache());
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetProForTests();
  mockDb.reset();
});
afterAll(() => server.close());

async function openProSheet(): Promise<HTMLElement> {
  (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
  render(
    <AuthProvider>
      <ProScreen />
      <ProCheckoutHost />
    </AuthProvider>,
  );
  fireEvent.click(await screen.findByTestId("pro-get"));
  await waitFor(() => expect((screen.getByTestId("pro-stripe-pay") as HTMLButtonElement).disabled).toBe(false));
  delete (globalThis as { __mockDb?: typeof mockDb }).__mockDb;
  return screen.getByTestId("pay-lines");
}

describe("/pro and its payment sheet", () => {
  it("on: the note under the plans, and the sheet's line says it", async () => {
    mockDb.adaptivePricing = true;
    const lines = await openProSheet();
    expect(screen.getByTestId("pro-local-note").textContent).toBe(LOCAL);
    expect(screen.getByTestId("pro-plan-weekly").textContent).toContain("$3.99");
    // inside the open sheet: the payment form shows it, with the base price
    expect(lines.textContent).toContain("The payment form shows the price in your currency. Base price US$3.99.");
    expect(lines.textContent).not.toContain(USD);
  });

  it("off: no note, \"Charged in US dollars.\" as before", async () => {
    mockDb.adaptivePricing = false;
    const lines = await openProSheet();
    await settle();
    expect(screen.queryByTestId("pro-local-note")).toBeNull();
    expect(lines.textContent).toContain(USD);
    expect(lines.textContent).not.toContain(LOCAL);
  });
});

describe("the plans sheet and the plans intro", () => {
  it("the plans sheet shows the note while it's on", async () => {
    mockDb.adaptivePricing = true;
    render(
      <AuthProvider>
        <BillingProvider>
          <PlansSheet open onClose={() => {}} preset="4k" reason="preview_done" />
        </BillingProvider>
      </AuthProvider>,
    );
    expect((await screen.findByTestId("plans-sheet-local-note")).textContent).toBe(LOCAL);
  });

  it("the plans intro: on shows it on the Pro card, off doesn't", async () => {
    const pricing = async () => (await (await fetch(`${GATEWAY}/v1/pricing`)).json()) as PublicPricing;
    mockDb.adaptivePricing = true;
    render(
      <AuthProvider>
        <BillingProvider>
          <PayPerVideoAndPro pricing={await pricing()} />
        </BillingProvider>
      </AuthProvider>,
    );
    expect((await screen.findByTestId("plan-pro-local-note")).textContent).toBe(LOCAL);
    cleanup();
    resetPricingCache();
    mockDb.adaptivePricing = false;
    render(
      <AuthProvider>
        <BillingProvider>
          <PayPerVideoAndPro pricing={await pricing()} />
        </BillingProvider>
      </AuthProvider>,
    );
    await screen.findByTestId("plan-pro");
    await settle();
    expect(screen.queryByTestId("plan-pro-local-note")).toBeNull();
  });
});
