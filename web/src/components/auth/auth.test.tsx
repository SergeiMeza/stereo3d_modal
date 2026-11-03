/**
 * Auth surface tests. Vitest runs in mock auth mode (NEXT_PUBLIC_AUTH_MODE
 * unset), so nothing here ever loads the Firebase SDK — these cover the
 * mock-mode contracts every other screen leans on: the landing CTA, the
 * mocked /signin, RequireAuth passing through, and the account profile.
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

import Home from "@/app/page";
import AccountScreen from "@/components/auth/AccountScreen";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { DUES_LINE } from "@/components/pay/DeleteDues";
import SignInScreen from "@/components/auth/SignInScreen";
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
  cleanup(); // vitest runs with globals:false, so RTL auto-cleanup is off
  vi.restoreAllMocks();
  replace.mockClear();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function renderWithAuth(ui: React.ReactElement) {
  return render(
    <AuthProvider>
      <BillingProvider>{ui}</BillingProvider>
    </AuthProvider>,
  );
}

describe("landing page", () => {
  it("shows the pitch and the CTA into /projects (mock user is signed in)", () => {
    renderWithAuth(<Home />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Turn any video into lifelike 3D",
    );
    for (const cta of screen.getAllByRole("link", { name: "Make your first 3D video" })) {
      expect(cta.getAttribute("href")).toBe("/projects");
    }
    // "How it looks": the new app's screens as tabs
    for (const screenName of ["Projects", "Make 3D", "Progress", "Files"]) {
      expect(screen.getByRole("tab", { name: screenName })).toBeTruthy();
    }
  });

  it("switches the screenshot when a tab is clicked", () => {
    renderWithAuth(<Home />);
    // Make 3D opens first
    expect(screen.getByRole("tab", { name: "Make 3D" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("tabpanel").querySelector("img")?.getAttribute("src"),
    ).toContain("%2Flanding%2Fui%2Ffiles.webp");
    // S3D-01: the landing never offers Classic
    expect(document.body.textContent).not.toMatch(/Classic/);
    // no technical terms on the landing page (S3D-36), no top-bottom (S3D-08)
    expect(document.body.textContent).not.toMatch(
      /inpainting|video-native model|depth map|top-bottom|splat|gaussian/i,
    );
  });
});

describe("SignInScreen (mock mode)", () => {
  it("explains auth is mocked and offers a plain Continue into /projects", () => {
    renderWithAuth(<SignInScreen />);
    expect(
      screen.getByText("Auth is mocked in this environment."),
    ).toBeTruthy();
    const cta = screen.getByRole("link", { name: "Continue" });
    expect(cta.getAttribute("href")).toBe("/projects");
  });
});

describe("RequireAuth (mock mode)", () => {
  it("renders children immediately without redirecting", () => {
    renderWithAuth(
      <RequireAuth>
        <p>guarded content</p>
      </RequireAuth>,
    );
    expect(screen.getByText("guarded content")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("AccountScreen billing (mock mode)", () => {
  it("points to Billing for the card and purchase history (S3D-57)", () => {
    renderWithAuth(<AccountScreen />);
    expect(
      screen.getByRole("link", { name: "Billing" }).getAttribute("href"),
    ).toBe("/account/billing");
    expect(screen.queryByTestId("card-on-file")).toBeNull();
  });
});

describe("AccountScreen (mock mode)", () => {
  it("renders the mock user's profile fields", () => {
    renderWithAuth(<AccountScreen />);
    expect(screen.getByText("dev@example.com")).toBeTruthy();
    expect(screen.getByText("dev-user")).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy(); // "password" provider badge
    const nameInput = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(nameInput.value).toBe("Dev User");
  });

  it("copies the UID to the clipboard from the Copy ID button", async () => {
    // fireEvent, not userEvent: userEvent.setup() installs its own
    // navigator.clipboard stub, which would clobber this spy
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderWithAuth(<AccountScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Copy ID" }));

    expect(writeText).toHaveBeenCalledWith("dev-user");
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

});

describe("AccountScreen delete (mock mode)", () => {
  function typeDeleteAndConfirm() {
    fireEvent.change(screen.getByLabelText(/Type DELETE/), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
  }

  function settleAllRuns() {
    for (const c of mockDb.conversions.values()) {
      if (["created", "paid", "processing"].includes(c.state))
        c.state = "canceled";
    }
  }

  it("deletes through the gateway and leaves the account", async () => {
    settleAllRuns();
    renderWithAuth(<AccountScreen />);
    typeDeleteAndConfirm();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  // 2026-10-27: a deleted account kept a $3.33 charge nobody could settle.
  it("refuses while a charge is unpaid and says how much", async () => {
    settleAllRuns();
    mockDb.billing.unpaid.push({
      conversion_id: "c00000000333",
      step: "depth_preview",
      amount_cents: 333,
      currency: "usd",
      needs_action: false,
    });
    renderWithAuth(<AccountScreen />);
    typeDeleteAndConfirm();
    // P13: the dues notice with Pay $3.33 (the settle sheet), not a dead end
    expect(await screen.findByTestId("delete-dues")).toBeTruthy();
    expect(screen.getByText(DUES_LINE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pay $3.33" })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  // gateway 00081: a cash balance is refunded first, then the account goes
  it("with a balance: confirm the refund, then deletion is pending", async () => {
    settleAllRuns();
    mockDb.billing.prepaid.balance_cents = 1250;
    mockDb.billing.prepaid.topups = 1;
    renderWithAuth(<AccountScreen />);
    typeDeleteAndConfirm();
    const refund = await screen.findByTestId("delete-refund");
    expect(refund.textContent).toContain("We return your $12.50 balance to your payment method first.");
    fireEvent.click(screen.getByRole("button", { name: "Refund and delete" }));
    expect((await screen.findByTestId("deletion-pending")).textContent).toBe(
      "We're returning your $12.50; your account is deleted once that's done.",
    );
    expect(mockDb.billing.deletionPending).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Delete account" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
