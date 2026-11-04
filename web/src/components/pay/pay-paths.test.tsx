/**
 * The run pay paths against a stand-in Stripe Checkout (before ADR 0138
 * moves the checkout state into atoms): confirm sends no returnUrl (the
 * gateway's session carries it, staging 2026-11-05), a throw is a decline
 * and never a spinner, an expired session shows Start again, and a run
 * without its Stripe key gets it from pay-now (the key fallback).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversion } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { PaySheet } from "./PaySheet";

const stripe = vi.hoisted(() => ({
  confirm: vi.fn(),
  status: { type: "open" } as { type: string; paymentStatus?: string },
  keys: [] as string[],
}));

vi.mock("@/components/billing/stripeLoader", () => ({
  getStripe: (key: string) => {
    stripe.keys.push(key);
    return Promise.resolve(null);
  },
}));

vi.mock("@stripe/react-stripe-js/checkout", () => ({
  CheckoutElementsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useCheckoutElements: () => ({
    type: "success",
    checkout: { confirm: stripe.confirm, getSession: () => ({ status: stripe.status }) },
  }),
  ExpressCheckoutElement: () => null,
  PaymentElement: () => null,
  BillingAddressElement: () => null,
  TaxIdElement: () => null,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  stripe.confirm.mockReset();
  stripe.status = { type: "open" };
  stripe.keys = [];
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const SECRET = "cs_test_run_cpay00000001_secret";

function run(key?: string): Conversion {
  const c: Conversion = {
    conversion_id: "cpay00000001",
    state: "created",
    kind: "video",
    project_id: "a1b2c3d4e5f6",
    step: "production",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: { amount_cents: 2312, currency: "usd" },
    progress: 0,
    billing: {
      status: "requires_payment",
      reason: "no_method",
      checkout: { client_secret: SECRET, expires_at: new Date(Date.now() + 20 * 60_000).toISOString() },
      ...(key ? { publishable_key: key } : {}),
    },
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:00:00Z",
  };
  mockDb.conversions.set(c.conversion_id, c);
  return c;
}

function sheet(c: Conversion) {
  const onClose = vi.fn();
  render(
    <AuthProvider>
      <PaySheet
        conversionId={c.conversion_id}
        amountCents={c.quote.amount_cents}
        action="Make 3D"
        billing={c.billing}
        run={c}
        onClose={onClose}
      />
    </AuthProvider>,
  );
  return onClose;
}

describe("the run pay sheet on Stripe Checkout", () => {
  it("confirms with no returnUrl and finishes when paid", async () => {
    stripe.confirm.mockResolvedValue({ type: "success", session: { status: { type: "complete", paymentStatus: "paid" } } });
    const onClose = sheet(run("pk_test_run"));
    fireEvent.click(await screen.findByTestId("pay-main"));
    expect(await screen.findByTestId("pay-success")).toBeTruthy();
    expect(stripe.confirm).toHaveBeenCalledTimes(1);
    expect(stripe.confirm.mock.calls[0][0]).toEqual({ redirect: "if_required" });
    expect(stripe.confirm.mock.calls[0][0]).not.toHaveProperty("returnUrl");
    expect(stripe.keys).toContain("pk_test_run");
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("paid"), { timeout: 3000 });
  });

  it("a confirm that throws is a decline with the button back, never a spinner", async () => {
    stripe.confirm.mockRejectedValue(new Error("Stripe refused this confirm."));
    sheet(run("pk_test_run"));
    fireEvent.click(await screen.findByTestId("pay-main"));
    expect((await screen.findByTestId("pay-error")).textContent).toBe("Stripe refused this confirm.");
    expect((screen.getByTestId("pay-main") as HTMLButtonElement).disabled).toBe(false);
  });

  it("an expired session at confirm shows Start again", async () => {
    stripe.status = { type: "expired" };
    stripe.confirm.mockResolvedValue({ type: "error", error: { code: null, message: "This Checkout Session is no longer active." } });
    sheet(run("pk_test_run"));
    fireEvent.click(await screen.findByTestId("pay-main"));
    expect(await screen.findByTestId("pay-expired")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy();
  });

  it("a run without its Stripe key gets the key (and the session) from pay-now", async () => {
    const c = run();
    let asked = 0;
    const { http, HttpResponse } = await import("msw");
    const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
    server.use(
      http.post(`${GATEWAY}/v1/conversions/:id/pay-now`, () => {
        asked += 1;
        return HttpResponse.json({
          checkout: c.billing!.checkout,
          amount_cents: 2312,
          publishable_key: "pk_test_from_pay_now",
        });
      }),
    );
    sheet(c);
    expect(await screen.findByTestId("pay-main")).toBeTruthy();
    expect(asked).toBe(1);
    expect(stripe.keys).toContain("pk_test_from_pay_now");
  });
});
