/**
 * BUX-03: the wallet row (Apple Pay, Google Pay, Link) pays through the
 * sheet's own paying → result path: a decline says so and the button comes
 * back, success shows Paid in the sheet, and one payment runs at a time.
 * The Stripe path is checked with a stand-in for the Checkout Elements SDK
 * (no Stripe.js in tests): the wallet confirm asks for redirect
 * "if_required" and a second tap fails in the wallet's own sheet.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Conversion } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { CheckoutPane, type ConfirmResult } from "./CheckoutPane";
import { PaySheet } from "./PaySheet";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const WALLET_DECLINED = "Your wallet payment didn't go through. Try again or pay another way.";

// the Checkout Elements SDK stand-in, for the Stripe path
const sdk = vi.hoisted(() => ({
  confirm: vi.fn(),
  onConfirm: null as null | ((e: unknown) => void),
}));
vi.mock("@stripe/react-stripe-js/checkout", () => ({
  CheckoutElementsProvider: ({ children }: { children: React.ReactNode }) => children,
  useCheckoutElements: () => ({ type: "success", checkout: { confirm: sdk.confirm, getSession: () => ({}) } }),
  CurrencySelectorElement: () => null,
  PaymentElement: () => null,
  ExpressCheckoutElement: ({ onConfirm }: { onConfirm: (e: unknown) => void }) => {
    sdk.onConfirm = onConfirm;
    return null;
  },
}));
vi.mock("@/components/billing/stripeLoader", () => ({ getStripe: () => Promise.resolve(null) }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  sdk.confirm.mockReset();
  sdk.onConfirm = null;
});
afterAll(() => server.close());

const SECRET = "cs_mock_run_cwal00000001_abc123";

function waitingRun(): Conversion {
  const c: Conversion = {
    conversion_id: "cwal00000001",
    state: "created",
    kind: "video",
    project_id: "a1b2c3d4e5f6",
    step: "production",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: { amount_cents: 1200, currency: "usd" },
    progress: 0,
    billing: {
      status: "requires_payment",
      reason: "no_method",
      checkout: { client_secret: SECRET, expires_at: new Date(Date.now() + 600_000).toISOString() },
    },
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:00:00Z",
  };
  mockDb.conversions.set(c.conversion_id, c);
  mockDb.billing.checkouts.set(SECRET, {
    kind: "run",
    conversion_id: c.conversion_id,
    amount_cents: 1200,
    state: "open",
    expires_at: c.billing!.checkout!.expires_at,
  });
  return c;
}

function sheet(run: Conversion) {
  const onClose = vi.fn();
  render(
    <AuthProvider>
      <PaySheet
        conversionId={run.conversion_id}
        amountCents={run.quote.amount_cents}
        action="Make 3D"
        billing={run.billing}
        run={run}
        onClose={onClose}
      />
    </AuthProvider>,
  );
  return onClose;
}

describe("the wallet row pays in the sheet (BUX-03)", () => {
  it("a wallet decline says so and the button comes back", async () => {
    sheet(waitingRun());
    mockDb.billing.nextConfirm = "declined";
    fireEvent.click(await screen.findByTestId("mock-wallet"));
    expect((await screen.findByTestId("pay-error")).textContent).toBe(WALLET_DECLINED);
    expect((screen.getByTestId("pay-main") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a wallet success shows Paid in the sheet", async () => {
    sheet(waitingRun());
    fireEvent.click(await screen.findByTestId("mock-wallet"));
    expect((await screen.findByTestId("pay-success")).textContent).toContain("Paid. Starting your 3D…");
  });

  it("locks while it pays: the sheet says Paying… and a second tap confirms nothing", async () => {
    let confirms = 0;
    server.use(
      http.post(`${GATEWAY}/__mock__/checkout/:secret/confirm`, async () => {
        confirms += 1;
        await delay(150);
        return HttpResponse.json({ result: "paid" });
      }),
    );
    sheet(waitingRun());
    const wallet = await screen.findByTestId("mock-wallet");
    fireEvent.click(wallet);
    fireEvent.click(wallet);
    await waitFor(() => expect(screen.getByTestId("pay-main").textContent).toContain("Paying"));
    expect((screen.getByTestId("pay-main") as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByTestId("pay-success")).toBeTruthy();
    expect(confirms).toBe(1);
  });
});

describe("the Stripe wallet confirm (BUX-03)", () => {
  function pane(onWallet: (r: Promise<ConfirmResult>) => void) {
    render(
      <CheckoutPane clientSecret="cs_test_wallet" publishableKey="pk_test" onWallet={onWallet}>
        {(form, body) => (
          <div>
            {body}
            <p data-testid="msg">{form.message}</p>
          </div>
        )}
      </CheckoutPane>,
    );
  }
  const event = () => ({ paymentFailed: vi.fn(), expressPaymentType: "apple_pay" });

  it("confirms with redirect if_required and hands the sheet the result", async () => {
    sdk.confirm.mockResolvedValue({ type: "success", session: { status: { type: "complete", paymentStatus: "paid" } } });
    const results: Promise<ConfirmResult>[] = [];
    pane((r) => results.push(r));
    const e = event();
    act(() => sdk.onConfirm!(e));
    expect(sdk.confirm).toHaveBeenCalledWith({ expressCheckoutConfirmEvent: e, redirect: "if_required" });
    await expect(results[0]).resolves.toBe("paid");
    expect(e.paymentFailed).not.toHaveBeenCalled();
  });

  it("a declined wallet is a decline with the wallet's line", async () => {
    sdk.confirm.mockResolvedValue({ type: "error", error: { code: "paymentFailed", message: "Card declined" } });
    const results: Promise<ConfirmResult>[] = [];
    pane((r) => results.push(r));
    act(() => sdk.onConfirm!(event()));
    await expect(results[0]).resolves.toBe("declined");
    await waitFor(() => expect(screen.getByTestId("msg").textContent).toBe(WALLET_DECLINED));
  });

  it("a second wallet tap while one runs fails in the wallet's sheet", async () => {
    let finish: (v: unknown) => void = () => {};
    sdk.confirm.mockReturnValue(new Promise((r) => (finish = r)));
    const results: Promise<ConfirmResult>[] = [];
    pane((r) => results.push(r));
    act(() => sdk.onConfirm!(event()));
    const second = event();
    act(() => sdk.onConfirm!(second));
    expect(second.paymentFailed).toHaveBeenCalledWith({ reason: "fail" });
    expect(sdk.confirm).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    finish({ type: "success", session: { status: { type: "complete", paymentStatus: "paid" } } });
    await expect(results[0]).resolves.toBe("paid");
  });
});
