/**
 * Pay-as-you-go billing surfaces: the RequireBilling gate (onboarding
 * redirect vs pass-through vs fail-open), the onboarding screen's save →
 * confirm → continue flow (mock setup implementation, same boundary
 * selection as production code paths), and the delinquency banner's settle
 * flows (success, 3DS requires_action, repeat decline).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { RequireBilling } from "@/components/billing/RequireBilling";
import { SettleProvider } from "@/components/pay/SettleSheet";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace,
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/projects",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  replace.mockClear();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function renderWithBilling(ui: React.ReactElement) {
  return render(
    <AuthProvider>
      <BillingProvider>{ui}</BillingProvider>
    </AuthProvider>,
  );
}

describe("RequireBilling", () => {
  it("renders children when a payment method is on file", async () => {
    renderWithBilling(
      <RequireBilling>
        <p>studio content</p>
      </RequireBilling>,
    );
    expect(await screen.findByText("studio content")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("no wall when nothing is saved: the first paid run opens the pay sheet instead (spec v6)", async () => {
    mockDb.billing.hasPaymentMethod = false;
    mockDb.billing.card = undefined;
    renderWithBilling(
      <RequireBilling>
        <p>studio content</p>
      </RequireBilling>,
    );
    expect(await screen.findByText("studio content")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("billing-banner")).toBeNull();
  });

  it("fails open when the billing fetch errors — the gateway 402 is the backstop", async () => {
    const { HttpResponse, http } = await import("msw");
    const GATEWAY =
      process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
    server.use(
      http.get(`${GATEWAY}/v1/billing`, () =>
        HttpResponse.json(
          { success: false, error: "server_error", message: "boom" },
          { status: 500 },
        ),
      ),
    );
    renderWithBilling(
      <RequireBilling>
        <p>studio content</p>
      </RequireBilling>,
    );
    expect(await screen.findByText("studio content")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows the delinquency banner when an automatic charge is outstanding", async () => {
    mockDb.billing.unpaid.push({
      conversion_id: "m0cdeadbeef1",
      amount_cents: 120,
      currency: "usd",
      needs_action: false,
    });
    renderWithBilling(
      <RequireBilling>
        <p>studio content</p>
      </RequireBilling>,
    );
    // delinquent users still reach their work — banner + content together
    // QA 2026-11-07: "You have $X to pay…" with Pay now (the settle sheet)
    expect(await screen.findByTestId("payment-issue-owed")).toBeTruthy();
    expect(screen.getByText("studio content")).toBeTruthy();
    expect(screen.getByTestId("payment-issue-owed").textContent).toContain(
      "You have $1.20 to pay. Your downloads come back as soon as it's paid.",
    );
    expect(screen.getByTestId("payment-issue-pay-owed").textContent).toBe("Pay now");
  });
});

describe("BillingBanner settle flows (P9 → P2)", () => {
  function seedDebt(cents = 350) {
    mockDb.billing.unpaid.push({
      conversion_id: "m0cdeadbeef1",
      amount_cents: cents,
      currency: "usd",
      needs_action: false,
    });
  }

  function renderShell() {
    return renderWithBilling(
      <SettleProvider>
        <RequireBilling>
          <p>studio content</p>
        </RequireBilling>
      </SettleProvider>,
    );
  }

  it("Pay $X opens the settle sheet; paying clears the banner", async () => {
    seedDebt();
    renderShell();
    fireEvent.click(await screen.findByTestId("payment-issue-pay-owed"));
    await screen.findByTestId("settle-main");
    const sheet = screen.getByTestId("settle-sheet");
    expect(within(sheet).getByRole("heading").textContent).toBe("Pay for your last runs");
    expect(within(sheet).getByText("1 run · charged after it was done")).toBeTruthy();
    expect(within(sheet).getByTestId("pay-lines").textContent).toBe("Charged in US dollars.");
    expect(within(sheet).getByText("Your downloads come back as soon as it's paid.")).toBeTruthy();
    expect(within(sheet).queryByTestId("pay-save-line")).toBeNull();
    fireEvent.click(within(sheet).getByTestId("settle-main"));
    expect(await screen.findByText("Paid. Your downloads are back.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("payment-issue-owed")).toBeNull());
    expect(mockDb.billing.unpaid).toHaveLength(0);
  });

  it("the balance covers it: Pay $X from your balance, the form under or pay another way (spec v7 P2)", async () => {
    seedDebt(725);
    const pp = mockDb.billing.prepaid;
    pp.balance_cents = 2000;
    pp.last_topup_at = "2026-11-01T00:00:00Z";
    pp.topups = 1;
    renderShell();
    fireEvent.click(await screen.findByTestId("payment-issue-pay-owed"));
    const main = await screen.findByTestId("settle-balance");
    expect(main.textContent).toBe("Pay $7.25 from your balance");
    expect(screen.getAllByText("or pay another way").length).toBeGreaterThan(0);
    expect(screen.getByTestId("settle-main")).toBeTruthy();
    fireEvent.click(main);
    expect(await screen.findByText("Paid. Your downloads are back.")).toBeTruthy();
    expect(mockDb.billing.unpaid).toHaveLength(0);
    expect(mockDb.billing.prepaid.balance_cents).toBe(1275);
  });

  it("a payment still in progress: Confirming your payment…, no button", async () => {
    seedDebt();
    renderShell();
    fireEvent.click(await screen.findByTestId("payment-issue-pay-owed"));
    await screen.findByTestId("settle-main");
    const sheet = screen.getByTestId("settle-sheet");
    mockDb.billing.nextConfirm = "processing";
    fireEvent.click(within(sheet).getByTestId("settle-main"));
    expect(await screen.findByTestId("settle-confirming")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.getByTestId("billing-banner").textContent).toBe("Confirming your payment…"),
    );
    expect(screen.queryByTestId("payment-issue-pay-owed")).toBeNull();
  });

  it("a decline keeps the sheet and the banner", async () => {
    seedDebt();
    renderShell();
    fireEvent.click(await screen.findByTestId("payment-issue-pay-owed"));
    await screen.findByTestId("settle-main");
    const sheet = screen.getByTestId("settle-sheet");
    mockDb.billing.nextConfirm = "declined";
    fireEvent.click(within(sheet).getByTestId("settle-main"));
    expect((await within(sheet).findByTestId("pay-error")).textContent).toBe(
      "Your payment method was declined. Try another way to pay.",
    );
    expect(screen.getByTestId("payment-issue-owed")).toBeTruthy();
    expect(mockDb.billing.unpaid).toHaveLength(1);
  });

  it("under review: the banner says so with Contact support", async () => {
    mockDb.billing.underReview = true;
    renderShell();
    const banner = await screen.findByTestId("billing-banner");
    expect(banner.textContent).toContain("We're checking a payment on your account.");
    expect(screen.getByTestId("billing-support").getAttribute("href")).toMatch(/^mailto:/);
  });
});
