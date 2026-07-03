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

import OnboardingScreen from "@/components/billing/OnboardingScreen";
import { RequireBilling } from "@/components/billing/RequireBilling";
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

  it("replace-redirects to /onboarding when no payment method is saved", async () => {
    mockDb.billing.hasPaymentMethod = false;
    mockDb.billing.card = undefined;
    renderWithBilling(
      <RequireBilling>
        <p>studio content</p>
      </RequireBilling>,
    );
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/onboarding?next=%2Fprojects"),
    );
    expect(screen.queryByText("studio content")).toBeNull();
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
    expect(await screen.findByTestId("billing-banner")).toBeTruthy();
    expect(screen.getByText("studio content")).toBeTruthy();
    expect(screen.getByText(/\$1\.20/)).toBeTruthy();
  });
});

describe("OnboardingScreen", () => {
  it("redirects straight through when a card is already on file", async () => {
    renderWithBilling(<OnboardingScreen />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/projects"));
  });

  it("saves a card (mock setup), confirms via GET /v1/billing, and continues", async () => {
    mockDb.billing.hasPaymentMethod = false;
    mockDb.billing.card = undefined;
    renderWithBilling(<OnboardingScreen />);

    const save = await screen.findByRole("button", {
      name: "Save test card",
    });
    fireEvent.click(save);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/projects"));
    expect(mockDb.billing.hasPaymentMethod).toBe(true);
  });
});

describe("BillingBanner settle flows", () => {
  function seedDebt() {
    mockDb.billing.unpaid.push({
      conversion_id: "m0cdeadbeef1",
      amount_cents: 350,
      currency: "usd",
      needs_action: false,
    });
  }

  it("Retry charge settles the debt and clears the banner", async () => {
    seedDebt();
    renderWithBilling(
      <RequireBilling>
        <p>studio content</p>
      </RequireBilling>,
    );
    fireEvent.click(await screen.findByTestId("billing-retry"));
    await waitFor(() =>
      expect(screen.queryByTestId("billing-banner")).toBeNull(),
    );
    expect(mockDb.billing.unpaid).toHaveLength(0);
  });

  it("completes a 3DS challenge (requires_action → confirm → settled)", async () => {
    seedDebt();
    mockDb.billing.settleOutcome = "requires_action";
    renderWithBilling(
      <RequireBilling>
        <p>studio content</p>
      </RequireBilling>,
    );
    fireEvent.click(await screen.findByTestId("billing-retry"));
    // the mock 3DS completion settles the debt, then refresh clears the banner
    await waitFor(() =>
      expect(screen.queryByTestId("billing-banner")).toBeNull(),
    );
    expect(mockDb.billing.unpaid).toHaveLength(0);
  });

  it("surfaces a repeat decline and keeps the banner", async () => {
    seedDebt();
    mockDb.billing.settleOutcome = "declined";
    renderWithBilling(
      <RequireBilling>
        <p>studio content</p>
      </RequireBilling>,
    );
    fireEvent.click(await screen.findByTestId("billing-retry"));
    expect(
      await screen.findByText(/declined again/),
    ).toBeTruthy();
    expect(screen.getByTestId("billing-banner")).toBeTruthy();
    expect(mockDb.billing.unpaid).toHaveLength(1);
  });
});
