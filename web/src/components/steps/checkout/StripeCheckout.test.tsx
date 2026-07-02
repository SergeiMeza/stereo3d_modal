/**
 * StripeCheckout tests: Payment Element panel rendering (amount button +
 * element), confirmPayment wiring (redirect: "if_required"), onPaid on
 * hold-in-place statuses (manual capture → requires_capture), inline error
 * rendering without onPaid, loadStripe memoized once per publishable key,
 * and the CheckoutProvider default selection (mock in test/mock mode,
 * stripe otherwise).
 *
 * @stripe/react-stripe-js and @stripe/stripe-js are mocked: Elements is a
 * children passthrough that records its options; PaymentElement is a
 * placeholder that fires onReady (the real element does so once mounted).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CheckoutSession } from "./CheckoutProvider";
import { defaultCheckout } from "./CheckoutProvider";
import { mockCheckout } from "./MockCheckout";
import { stripeCheckout, StripeCheckoutPanel } from "./StripeCheckout";

const h = vi.hoisted(() => ({
  confirmPayment: vi.fn<() => Promise<unknown>>(),
  elementsOptions: [] as unknown[],
  loadStripe: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: h.loadStripe,
}));

vi.mock("@stripe/react-stripe-js", async () => {
  const React = await import("react");
  function Elements({
    options,
    children,
  }: {
    options: unknown;
    children: React.ReactNode;
  }): React.JSX.Element {
    h.elementsOptions.push(options);
    return React.createElement(React.Fragment, null, children);
  }
  function PaymentElement({
    onReady,
  }: {
    onReady?: () => void;
  }): React.JSX.Element {
    React.useEffect(() => {
      onReady?.();
    }, [onReady]);
    return React.createElement("div", { "data-testid": "payment-element" });
  }
  return {
    Elements,
    PaymentElement,
    useStripe: () => ({ confirmPayment: h.confirmPayment }),
    useElements: () => ({}),
  };
});

function session(pk = "pk_test_a"): CheckoutSession {
  return {
    conversionId: "conv-1",
    amountCents: 1234,
    currency: "usd",
    payment: {
      payment_intent_client_secret: "pi_1_secret_x",
      ephemeral_key_secret: "ek_x",
      customer_id: "cus_x",
      publishable_key: pk,
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  h.confirmPayment.mockReset();
  h.elementsOptions.length = 0;
});

describe("StripeCheckoutPanel", () => {
  it("renders the amount, the PaymentElement, and passes the client secret to Elements", async () => {
    render(<StripeCheckoutPanel session={session()} onPaid={() => {}} />);
    expect(screen.getByTestId("payment-element")).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "Pay $12.34 USD" }),
    ).toBeDefined();
    expect(
      screen.getByText("Held now — charged only when the conversion succeeds"),
    ).toBeDefined();
    expect(h.elementsOptions[0]).toMatchObject({
      clientSecret: "pi_1_secret_x",
    });
  });

  it("confirms with redirect if_required and fires onPaid once on requires_capture", async () => {
    h.confirmPayment.mockResolvedValue({
      paymentIntent: { status: "requires_capture" },
    });
    const onPaid = vi.fn();
    render(<StripeCheckoutPanel session={session()} onPaid={onPaid} />);
    const button = await screen.findByRole("button", {
      name: "Pay $12.34 USD",
    });
    fireEvent.click(button);
    await vi.waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(h.confirmPayment).toHaveBeenCalledWith({
      elements: expect.anything(),
      redirect: "if_required",
    });
  });

  it("renders error.message inline and does not fire onPaid on failure", async () => {
    h.confirmPayment.mockResolvedValue({
      error: { message: "Your card was declined." },
    });
    const onPaid = vi.fn();
    render(<StripeCheckoutPanel session={session()} onPaid={onPaid} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Pay $12.34 USD" }),
    );
    expect(await screen.findByText("Your card was declined.")).toBeDefined();
    expect(onPaid).not.toHaveBeenCalled();
  });

  it("calls loadStripe once per publishable key across renders", () => {
    const pk = "pk_test_memoized";
    render(<StripeCheckoutPanel session={session(pk)} onPaid={() => {}} />);
    cleanup();
    render(<StripeCheckoutPanel session={session(pk)} onPaid={() => {}} />);
    const calls = h.loadStripe.mock.calls.filter(
      (args) => (args as unknown[])[0] === pk,
    );
    expect(calls).toHaveLength(1);
  });
});

describe("defaultCheckout", () => {
  it("selects the mock implementation in the test environment", () => {
    // vitest sets NODE_ENV=test and does not load .env.local, so the
    // mock flag is absent — the NODE_ENV fallback keeps tests on mock.
    expect(defaultCheckout()).toBe(mockCheckout);
    expect(defaultCheckout().name).toBe("mock");
  });

  it("selects mock when NEXT_PUBLIC_API_MOCK=1 and stripe otherwise", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_MOCK", "1");
    expect(defaultCheckout()).toBe(mockCheckout);
    vi.stubEnv("NEXT_PUBLIC_API_MOCK", "0");
    expect(defaultCheckout()).toBe(stripeCheckout);
    expect(defaultCheckout().name).toBe("stripe");
  });
});
