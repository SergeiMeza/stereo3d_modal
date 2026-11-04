import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PasskeySuggestion } from "@/components/auth/PasskeySuggestion";
import { AuthProvider } from "@/lib/auth";
import { markPasskeySuggestion, passkeySuggestionMarked } from "@/lib/passkeys";
import { resetAccountSettingsCache } from "@/lib/useAccountSettings";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import { installWebAuthn } from "@/test/webauthn";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
let wa: ReturnType<typeof installWebAuthn>;
beforeEach(() => {
  wa = installWebAuthn();
  resetAccountSettingsCache();
});
afterEach(() => {
  cleanup();
  wa.uninstall();
  markPasskeySuggestion(false);
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const renderIt = () =>
  render(
    <AuthProvider>
      <PasskeySuggestion />
    </AuthProvider>,
  );

describe("the passkey suggestion after a sign-in (ADR 0136)", () => {
  it("shows once after a sign-in, and Dismiss keeps it away on the gateway", async () => {
    markPasskeySuggestion(true);
    renderIt();
    const s = await screen.findByTestId("passkey-suggestion");
    expect(s.textContent).toContain("Add a passkey to sign in faster next time.");
    fireEvent.click(within(s).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByTestId("passkey-suggestion")).toBeNull());
    await waitFor(() => expect(mockDb.accountSettings.dismissed.passkey_suggestion).toBeTruthy());
    expect(passkeySuggestionMarked()).toBe(false);
  });

  it("adds a passkey from the suggestion", async () => {
    markPasskeySuggestion(true);
    renderIt();
    fireEvent.click(within(await screen.findByTestId("passkey-suggestion")).getByRole("button", { name: "Add a passkey" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a passkey" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add passkey" }));
    expect(await screen.findByText("Passkey added. Next time, sign in with it.")).toBeTruthy();
    expect(mockDb.passkeys).toHaveLength(1);
    expect(passkeySuggestionMarked()).toBe(false);
  });

  it("not without a sign-in in this tab", async () => {
    renderIt();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("passkey-suggestion")).toBeNull();
  });

  it("not when the account has a passkey", async () => {
    markPasskeySuggestion(true);
    mockDb.passkeys = [{ id: "pk_1", name: "iPhone", device_hint: null, created_at: "2026-11-01T00:00:00Z", last_used_at: null }];
    renderIt();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("passkey-suggestion")).toBeNull();
  });

  it("not once it was dismissed (on any browser)", async () => {
    markPasskeySuggestion(true);
    mockDb.accountSettings.dismissed = { passkey_suggestion: "2026-11-01T00:00:00Z" };
    renderIt();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("passkey-suggestion")).toBeNull();
  });
});
