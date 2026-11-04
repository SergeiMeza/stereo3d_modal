import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PasskeysSection } from "@/components/auth/Passkeys";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import { installWebAuthn, notAllowed } from "@/test/webauthn";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
let wa: ReturnType<typeof installWebAuthn> | null = null;
afterEach(() => {
  cleanup();
  wa?.uninstall();
  wa = null;
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const seed = () => {
  mockDb.passkeys = [
    { id: "pk_1", name: "iPhone", device_hint: "iPhone", created_at: "2026-11-01T10:00:00Z", last_used_at: "2026-11-03T10:00:00Z" },
    { id: "pk_2", name: "Work laptop", device_hint: null, created_at: "2026-11-02T10:00:00Z", last_used_at: null },
  ];
};

const renderSection = () =>
  render(
    <AuthProvider>
      <PasskeysSection />
    </AuthProvider>,
  );

describe("Account → Sign-in & security: passkeys (ADR 0136)", () => {
  it("lists passkeys with device, added and last used", async () => {
    wa = installWebAuthn();
    seed();
    renderSection();
    const row = await screen.findByTestId("passkey-pk_1");
    expect(row.textContent).toContain("iPhone");
    expect(row.textContent).toMatch(/Added .*2026/);
    expect(row.textContent).toMatch(/Last used .*2026/);
    expect(screen.getByTestId("passkey-pk_2").textContent).toContain("Last used never");
  });

  it("adds a passkey with a name", async () => {
    wa = installWebAuthn();
    renderSection();
    expect(await screen.findByText("No passkeys yet.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("passkey-add"));
    const dialog = await screen.findByRole("dialog", { name: "Add a passkey" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Vision Pro" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add passkey" }));
    expect(await screen.findByText("Passkey added.")).toBeTruthy();
    expect(wa.create).toHaveBeenCalledTimes(1);
    expect(mockDb.passkeys[0]).toMatchObject({ id: "cred_new", name: "Vision Pro" });
    expect((await screen.findByTestId("passkey-cred_new")).textContent).toContain("Vision Pro");
  });

  it("puts the gateway's new passkey in the list without loading it again", async () => {
    wa = installWebAuthn();
    let lists = 0;
    const count = ({ request }: { request: Request }) => {
      if (request.method === "GET" && new URL(request.url).pathname === "/v1/account/passkeys") lists++;
    };
    server.events.on("request:start", count);
    renderSection();
    fireEvent.click(await screen.findByTestId("passkey-add"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Add passkey" }));
    expect(await screen.findByTestId("passkey-cred_new")).toBeTruthy();
    expect(lists).toBe(1);
    server.events.removeListener("request:start", count);
  });

  it("409 passkey_exists: this device already has one", async () => {
    wa = installWebAuthn();
    mockDb.passkeys = [{ id: "cred_new", name: "Mac", device_hint: "Safari on Mac", created_at: "2026-11-01T00:00:00Z", last_used_at: null }];
    renderSection();
    fireEvent.click(await screen.findByTestId("passkey-add"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add passkey" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("This device already has a passkey for your account.");
  });

  it("asks to sign in again when the sign-in is too old, then adds on the next press", async () => {
    wa = installWebAuthn();
    mockDb.passkeyReauthNeeded = true;
    renderSection();
    fireEvent.click(await screen.findByTestId("passkey-add"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add passkey" }));
    expect(await within(dialog).findByText("Sign in again")).toBeTruthy();
    expect(wa.create).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send a code to dev@example.com" }));
    fireEvent.change(await within(dialog).findByLabelText("Sign-in code"), { target: { value: "123456" } });
    expect(await within(dialog).findByText("Signed in again. Now add the passkey.")).toBeTruthy();
    mockDb.passkeyReauthNeeded = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Add passkey" }));
    expect(await screen.findByText("Passkey added.")).toBeTruthy();
  });

  it("a closed passkey prompt leaves the dialog open without an error", async () => {
    wa = installWebAuthn();
    wa.fail.create = notAllowed();
    renderSection();
    fireEvent.click(await screen.findByTestId("passkey-add"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add passkey" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Add passkey" })).toHaveProperty("disabled", false));
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("renames a passkey", async () => {
    wa = installWebAuthn();
    seed();
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Work laptop" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename passkey" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Studio Mac" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("passkey-pk_2").textContent).toContain("Studio Mac"));
    expect(mockDb.passkeys[1].name).toBe("Studio Mac");
  });

  it("removes a passkey after a confirm", async () => {
    wa = installWebAuthn();
    seed();
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Remove iPhone" }));
    const confirm = await screen.findByRole("alertdialog", { name: 'Remove "iPhone"?' });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove passkey" }));
    await waitFor(() => expect(screen.queryByTestId("passkey-pk_1")).toBeNull());
    expect(mockDb.passkeys.map((p) => p.id)).toEqual(["pk_2"]);
    expect(screen.getByText("Passkey removed.")).toBeTruthy();
  });

  it("a browser without passkeys can't add one but still lists them", async () => {
    seed();
    renderSection();
    expect(await screen.findByTestId("passkey-pk_1")).toBeTruthy();
    expect(screen.queryByTestId("passkey-add")).toBeNull();
  });
});
