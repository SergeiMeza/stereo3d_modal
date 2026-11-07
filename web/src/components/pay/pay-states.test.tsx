/**
 * BUX-02: a payment the bank is still confirming, or a session that timed
 * out (a top-up's ends after 30 minutes), is never shown as "declined", in
 * the Add funds sheet and the Pro sheet.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProCheckoutHost } from "@/components/pro/ProCheckoutHost";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { openProCheckout } from "@/lib/pro/checkoutStore";
import { plansFromPricing } from "@/lib/pro/plans";
import { resetProForTests } from "@/lib/pro/usePro";
import { MOCK_PRO_PLANS, mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { AddFundsSheet } from "./BalanceDialogs";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const DECLINED = "Your payment method was declined. Try another way to pay.";
const TIMED_OUT = "This payment timed out. Nothing was charged.";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/account/billing",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  resetPricingCache();
  resetProForTests();
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

/** The mock's confirm answers `result` once. */
function confirmOnce(result: string): void {
  server.use(
    http.post(`${GATEWAY}/__mock__/checkout/:secret/confirm`, () => HttpResponse.json({ result }), { once: true }),
  );
}

function renderFunds() {
  render(
    <AuthProvider>
      <BillingProvider>
        <AddFundsSheet onClose={vi.fn()} />
      </BillingProvider>
    </AuthProvider>,
  );
}

async function pressAdd(): Promise<void> {
  await waitFor(() => expect((screen.getByTestId("add-funds-main") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("add-funds-main"));
}

describe("Add funds: processing and expired are not declines (BUX-02)", () => {
  it("processing: the bank is confirming it", async () => {
    renderFunds();
    confirmOnce("processing");
    await pressAdd();
    expect((await screen.findByTestId("funds-waiting")).textContent).toBe(
      "Your bank is confirming this payment. We'll add it to your balance as soon as it's through.",
    );
    expect(screen.queryByText(DECLINED)).toBeNull();
  });

  it("expired at confirm: timed out, nothing charged, and Start again opens a new payment", async () => {
    let opened = 0;
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname === "/v1/billing/balance/topup") opened += 1;
    });
    renderFunds();
    confirmOnce("expired");
    await pressAdd();
    expect((await screen.findByTestId("funds-expired")).textContent).toBe(TIMED_OUT);
    expect(screen.queryByText(DECLINED)).toBeNull();
    expect(opened).toBe(1);
    fireEvent.click(screen.getByTestId("funds-start-again"));
    await pressAdd();
    expect(await screen.findByText("Added $25.00. Your balance is $25.00.")).toBeTruthy();
    expect(opened).toBe(2);
  });

  it("an idle form past the session's end says it timed out", async () => {
    server.use(
      http.post(`${GATEWAY}/v1/billing/balance/topup`, () =>
        HttpResponse.json({
          topup_id: "tu_soon",
          checkout: { client_secret: "cs_mock_topup_soon", expires_at: new Date(Date.now() + 600).toISOString() },
        }),
      ),
    );
    renderFunds();
    await waitFor(() => expect((screen.getByTestId("add-funds-main") as HTMLButtonElement).disabled).toBe(false));
    expect((await screen.findByTestId("funds-expired", {}, { timeout: 3000 })).textContent).toBe(TIMED_OUT);
  });
});

describe("Pro sheet: processing and expired are not declines (BUX-02)", () => {
  function renderPro() {
    render(
      <AuthProvider>
        <BillingProvider>
          <ProCheckoutHost />
        </BillingProvider>
      </AuthProvider>,
    );
    const monthly = plansFromPricing(MOCK_PRO_PLANS).find((p) => p.kind === "monthly")!;
    return openProCheckout(monthly);
  }

  async function pressStart(): Promise<void> {
    await waitFor(() => expect((screen.getByTestId("pro-stripe-pay") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("pro-stripe-pay"));
  }

  it("processing: Pro isn't claimed on; the bank is confirming it", async () => {
    const outcome = renderPro();
    confirmOnce("processing");
    await pressStart();
    expect((await screen.findByTestId("pro-stripe-waiting")).textContent).toBe(
      "Your bank is confirming this payment. Pro turns on as soon as it's through.",
    );
    expect(screen.queryByText(/Pro is on/)).toBeNull();
    expect(screen.queryByText(DECLINED)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await expect(outcome).resolves.toBe("cancelled");
  });

  it("expired: timed out, and Start again opens a new payment", async () => {
    renderPro();
    confirmOnce("expired");
    await pressStart();
    expect((await screen.findByTestId("pro-stripe-expired")).textContent).toBe(TIMED_OUT);
    expect(screen.queryByText(DECLINED)).toBeNull();
    fireEvent.click(screen.getByTestId("pro-start-again"));
    await pressStart();
    expect(await screen.findByText("Pro is on. Every video is cheaper now.")).toBeTruthy();
  });
});
