/**
 * BUX-15: after a top-up, auto-reload is offered once: opt-in, switched
 * off, one line and a switch; on, the consent with the saved method, and
 * only Turn on auto-reload saves it. Not now leaves it off.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resetPaymentMethodsForTests } from "@/lib/api/usePaymentMethods";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { AddFundsSheet } from "./BalanceDialogs";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/account/billing",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  resetPaymentMethodsForTests();
});
afterAll(() => server.close());

async function topUp(onClose = vi.fn()) {
  render(
    <AuthProvider>
      <BillingProvider>
        <AddFundsSheet onClose={onClose} />
      </BillingProvider>
    </AuthProvider>,
  );
  await waitFor(() => expect((screen.getByTestId("add-funds-main") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("add-funds-main"));
  expect(await screen.findByText("Added $25.00. Your balance is $25.00.")).toBeTruthy();
  return onClose;
}

describe("auto-reload offered after a top-up (BUX-15)", () => {
  it("off by default; nothing is saved until the switch is on and Turn on is pressed", async () => {
    await topUp();
    const sw = await screen.findByRole("switch", { name: "Never run out mid-project?" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("reload-offer-on")).toBeNull();
    expect(screen.queryByTestId("reload-offer-consent")).toBeNull();
    fireEvent.click(sw);
    expect(screen.getByTestId("reload-offer-consent").textContent).toBe(
      "We'll charge your default payment method (Visa •••• 4242) $25.00 whenever your balance drops below $10.00. If it's declined, we try your others. Charged in US dollars.",
    );
    expect(mockDb.billing.prepaid.auto_reload.enabled).toBe(false);
    fireEvent.click(screen.getByTestId("reload-offer-on"));
    expect(await screen.findByText("Auto-reload is on.")).toBeTruthy();
    expect(mockDb.billing.prepaid.auto_reload).toMatchObject({ enabled: true, below_cents: 1000, add_cents: 2500 });
  });

  it("Not now closes and leaves it off", async () => {
    const onClose = await topUp();
    fireEvent.click(await screen.findByTestId("reload-offer-not-now"));
    expect(onClose).toHaveBeenCalled();
    expect(mockDb.billing.prepaid.auto_reload.enabled).toBe(false);
  });

  it("already on: no offer, the sheet closes by itself", async () => {
    mockDb.billing.prepaid.auto_reload.enabled = true;
    mockDb.billing.hasPaymentMethod = true;
    const onClose = await topUp();
    expect(screen.queryByTestId("reload-offer")).toBeNull();
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 3000 });
  });
});
