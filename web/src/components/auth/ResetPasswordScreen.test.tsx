/**
 * /reset-password: the page the China-mode reset email links to. It posts
 * the ?oob= code and the new password to /v1/auth/reset/confirm (mock
 * gateway) and maps the refusals; the code leaves the address bar.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import ResetPasswordScreen from "@/components/auth/ResetPasswordScreen";
import { mockAuth } from "@/mocks/handlers";
import { server } from "@/mocks/server";

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => search.params,
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockAuth.reset();
  window.history.replaceState(null, "", "/");
});
afterAll(() => server.close());

/** Ask the mock gateway for a reset so it issues a code for the seeded user. */
async function issueCode(): Promise<string> {
  await fetch(`${GATEWAY}/v1/auth/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "dev@example.com" }),
  });
  return [...mockAuth.resetCodes.keys()][0];
}

function open(oob: string | null) {
  const query = oob === null ? "" : `?oob=${encodeURIComponent(oob)}`;
  window.history.replaceState(null, "", `/reset-password${query}`);
  search.params = new URLSearchParams(query);
  render(<ResetPasswordScreen />);
}

function fill(password: string, confirm = password) {
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: confirm },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
}

describe("ResetPasswordScreen", () => {
  it("sets the new password and points to sign in", async () => {
    const code = await issueCode();
    open(code);
    expect(window.location.search).toBe(""); // code dropped from the address bar
    fill("brand-new-pass");

    expect(await screen.findByText("Password saved")).toBeTruthy();
    expect(
      screen.getByText("Sign in as dev@example.com with your new password."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to sign in" }).getAttribute("href")).toBe(
      "/signin",
    );
    expect(mockAuth.users.get("dev@example.com")!.password).toBe("brand-new-pass");
    expect(mockAuth.resetCodes.size).toBe(0);
  });

  it("says when the link has expired and stops", async () => {
    open("expired-oob");
    fill("brand-new-pass");
    expect(
      await screen.findByText(
        "This link has expired. Ask for a new one from the sign-in page.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save password" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("link", { name: "Back to sign in" })).toBeTruthy();
  });

  it("says when the link was already used", async () => {
    open("used-or-made-up");
    fill("brand-new-pass");
    expect(
      await screen.findByText(
        "This link is not valid or was already used. Ask for a new one from the sign-in page.",
      ),
    ).toBeTruthy();
  });

  it("checks length and match before calling the gateway", async () => {
    const code = await issueCode();
    open(code);
    fill("abc");
    expect(
      screen.getByText("Choose a longer password: at least 6 characters."),
    ).toBeTruthy();
    fill("brand-new-pass", "brand-new-pas");
    expect(screen.getByText("The passwords don't match.")).toBeTruthy();
    expect(mockAuth.resetCodes.size).toBe(1); // nothing sent
  });

  it("maps a weak password from the gateway", async () => {
    // The account's password rules can be stricter than the form's.
    server.use(
      http.post(`${GATEWAY}/v1/auth/reset/confirm`, () =>
        HttpResponse.json(
          {
            success: false,
            error: "weak_password",
            message: "password is too weak; use at least 6 characters",
          },
          { status: 400 },
        ),
      ),
    );
    open("any-code");
    fill("123456");
    expect(
      await screen.findByText("Choose a longer password: at least 6 characters."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save password" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false); // the link still works
  });

  it("explains a link without a code", () => {
    open(null);
    expect(
      screen.getByText(
        "This link is not valid or was already used. Ask for a new one from the sign-in page.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("New password")).toBeNull();
  });
});
