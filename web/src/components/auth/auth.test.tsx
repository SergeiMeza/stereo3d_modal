/**
 * Auth surface tests. Vitest runs in mock auth mode (NEXT_PUBLIC_AUTH_MODE
 * unset), so nothing here ever loads the Firebase SDK — these cover the
 * mock-mode contracts every other screen leans on: the landing CTA, the
 * mocked /signin, RequireAuth passing through, and the account profile.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import Home from "@/app/page";
import AccountScreen from "@/components/auth/AccountScreen";
import {
  RequireAuth,
  resetEnsuredBillingProfiles,
} from "@/components/auth/RequireAuth";
import SignInScreen from "@/components/auth/SignInScreen";
import { AuthProvider } from "@/lib/auth";
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
  resetEnsuredBillingProfiles();
});
afterAll(() => server.close());

function renderWithAuth(ui: React.ReactElement) {
  return render(<AuthProvider>{ui}</AuthProvider>);
}

describe("landing page", () => {
  it("shows the pitch and an Open studio CTA into /projects (mock user is signed in)", () => {
    renderWithAuth(<Home />);
    expect(
      screen.getByText(/Turn any video into immersive stereoscopic 3D/),
    ).toBeTruthy();
    const cta = screen.getByRole("link", { name: "Open studio" });
    expect(cta.getAttribute("href")).toBe("/projects");
    // the 5-step strip is present
    for (const step of [
      "Upload",
      "Cut scenes",
      "Tune depth",
      "Preview stereo",
      "Deliver",
    ]) {
      expect(screen.getByText(step)).toBeTruthy();
    }
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

  it("ensures the billing profile on sign-in (POST /v1/customers) — conversions hard-fail without it", async () => {
    mockDb.billingProfile = false;
    renderWithAuth(
      <RequireAuth>
        <p>guarded content</p>
      </RequireAuth>,
    );
    await waitFor(() => expect(mockDb.billingProfile).toBe(true));
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

  it("opens the Stripe billing portal from Manage billing", async () => {
    const navigate = vi.fn();
    renderWithAuth(<AccountScreen navigateExternal={navigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "https://billing.stripe.com/p/session/mock",
      ),
    );
  });
});
