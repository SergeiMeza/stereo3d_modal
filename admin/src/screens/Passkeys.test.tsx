import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminSession, memoryStorage } from "../lib/adminSession";
import { apiError, FakeAuth, renderApp } from "../test/harness";
import { creationOptions, installWebAuthn, notAllowed, requestOptions } from "../test/webauthn";

const googleDone = () => new FakeAuth({ kind: "passkey", email: "owner@example.com", uid: "owner", hasFactor: false });
const cases = { "GET /v1/admin/cases": () => ({ json: { cases: [], counts: { open: 0, overdue: 0, due_today: 0 } } }) };

let wa: ReturnType<typeof installWebAuthn>;
beforeEach(() => {
  wa = installWebAuthn();
});
afterEach(() => wa.uninstall());

describe("passkey sign-in (ADR 0135)", () => {
  it("after Google: Use your passkey, then the console with X-Admin-Session on every call", async () => {
    const { calls } = renderApp(
      "/cases",
      {
        ...cases,
        "POST /v1/admin/session/options": () => ({ json: { options: { publicKey: requestOptions }, expires_at: "2026-11-04T10:05:00Z" } }),
        "POST /v1/admin/session/verify": () => ({
          json: { session: "sess_1", expires_at: "2099-11-04T22:00:00Z", last_assertion_at: "2026-11-04T10:00:00Z" },
        }),
      },
      googleDone(),
    );
    expect(await screen.findByText("Use your passkey to finish signing in.")).toBeInTheDocument();
    expect(screen.getByText(/A passkey uses Face ID, Touch ID, your phone or a security key. Nothing to type./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Use your passkey" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Use your passkey" }));
    expect(await screen.findByRole("heading", { name: "Cases" })).toBeInTheDocument();
    expect(wa.get).toHaveBeenCalledTimes(1);
    const verify = calls.find((c) => c.path === "/v1/admin/session/verify")!;
    expect(verify.body).toMatchObject({ purpose: "sign_in", response: { id: "cred_1", type: "public-key" } });
    expect(calls.find((c) => c.path === "/v1/admin/session/options")!.body).toEqual({ purpose: "sign_in" });
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/admin/cases")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/admin/cases")!.headers["X-Admin-Session"]).toBe("sess_1");
  });

  it("no passkey yet: Set up a passkey right after Google, then sign in with it", async () => {
    const { calls } = renderApp(
      "/cases",
      {
        ...cases,
        "POST /v1/admin/session/options": () =>
          calls.some((c) => c.path === "/v1/admin/passkeys/register/verify")
            ? { json: { options: { publicKey: requestOptions }, expires_at: "2026-11-04T10:05:00Z" } }
            : apiError(409, "no_passkey", "No passkey on this account yet."),
        "POST /v1/admin/passkeys/register/options": () => ({ json: { options: { publicKey: creationOptions }, expires_at: "2026-11-04T10:05:00Z" } }),
        "POST /v1/admin/passkeys/register/verify": () => ({
          json: { passkey: { id: "pk_1", name: "Mac · Safari", created_at: "2026-11-04T10:00:00Z" } },
        }),
        "POST /v1/admin/session/verify": () => ({ json: { session: "sess_2" } }),
      },
      googleDone(),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Set up a passkey" }));
    expect(await screen.findByText("Passkey added. Use it to sign in.")).toBeInTheDocument();
    expect(wa.create).toHaveBeenCalledTimes(1);
    const reg = calls.find((c) => c.path === "/v1/admin/passkeys/register/verify")!;
    expect(reg.body).toMatchObject({ response: { id: "cred_new", response: { transports: ["internal", "hybrid"] } } });
    expect(typeof (reg.body as { name: string }).name).toBe("string");
    await userEvent.click(screen.getByRole("button", { name: "Use your passkey" }));
    expect(await screen.findByRole("heading", { name: "Cases" })).toBeInTheDocument();
  });

  it("a closed passkey prompt says so and fetches a fresh challenge", async () => {
    let options = 0;
    renderApp(
      "/cases",
      {
        ...cases,
        "POST /v1/admin/session/options": () => {
          options++;
          return { json: { options: { publicKey: requestOptions }, expires_at: "2026-11-04T10:05:00Z" } };
        },
      },
      googleDone(),
    );
    wa.fail.get = notAllowed();
    await waitFor(() => expect(screen.getByRole("button", { name: "Use your passkey" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Use your passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The passkey prompt was closed or timed out. Try again.");
    await waitFor(() => expect(options).toBe(2));
  });

  it("keeps the authenticator code one link away", async () => {
    renderApp("/cases", { "POST /v1/admin/session/options": () => ({ json: { options: { publicKey: requestOptions }, expires_at: "2026-11-04T10:05:00Z" } }) }, googleDone());
    await userEvent.click(await screen.findByRole("button", { name: "Use an authenticator code instead" }));
    expect(screen.getByRole("button", { name: "Set up an authenticator app" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use a passkey instead" }));
    expect(await screen.findByRole("button", { name: "Use your passkey" })).toBeInTheDocument();
  });

  it("401 session_required {methods: passkey, totp}: the passkey step with the code link", async () => {
    const auth = new FakeAuth();
    renderApp(
      "/cases",
      {
        "GET /v1/admin/cases": () =>
          apiError(401, "session_required", "Confirm with your passkey (or sign in with your second factor).", { methods: ["passkey", "totp"] }),
        "POST /v1/admin/session/options": () => ({ json: { options: { publicKey: requestOptions }, expires_at: "x" } }),
      },
      auth,
    );
    expect(await screen.findByRole("button", { name: "Use your passkey" })).toBeInTheDocument();
    expect(auth.problems).toContain("session_required");
    expect(screen.getByRole("button", { name: "Use an authenticator code instead" })).toBeInTheDocument();
  });

  it("no TOTP link when the gateway takes only the passkey", async () => {
    renderApp(
      "/cases",
      {
        "GET /v1/admin/cases": () => apiError(401, "session_required", "Confirm with your passkey.", { methods: ["passkey"] }),
        "POST /v1/admin/session/options": () => ({ json: { options: { publicKey: requestOptions }, expires_at: "x" } }),
      },
      new FakeAuth(),
    );
    expect(await screen.findByRole("button", { name: "Use your passkey" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use an authenticator code instead" })).toBeNull();
  });

  it("an ended passkey session asks for the passkey again", async () => {
    const session = new AdminSession(memoryStorage());
    session.set("sess_old");
    renderApp(
      "/cases",
      {
        "GET /v1/admin/cases": () => apiError(401, "session_expired", "Your passkey session ended."),
        "POST /v1/admin/session/options": () => ({ json: { options: { publicKey: requestOptions }, expires_at: "2026-11-04T10:05:00Z" } }),
      },
      googleDone(),
      session,
    );
    expect(await screen.findByRole("button", { name: "Use your passkey" })).toBeInTheDocument();
    expect(session.get()).toBeNull();
  });

  it("signing out of Google drops the passkey session", async () => {
    const session = new AdminSession(memoryStorage());
    session.set("sess_1");
    const auth = googleDone();
    renderApp("/cases", cases, auth, session);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(session.get()).toBeNull());
  });
});

describe("money actions re-assert with the passkey (ADR 0135)", () => {
  const account = {
    account: { uid: "uid_123", email: "jane@example.com", stripe_customer_id: "cus_1", blocked: false },
    billing_state: { flow_state: "outstanding", sheet_only: false, lifetime_paid_cents: 0 },
    owed_cents: 125,
    balance: null,
    methods: null,
    cases: null,
    charges: null,
    refunds: null,
    ledger: null,
  };
  const signedIn = () => {
    const session = new AdminSession(memoryStorage());
    session.set("sess_1");
    return session;
  };

  it("401 reauth_required {method: passkey}: the passkey, then the action once more", async () => {
    let posts = 0;
    const auth = googleDone();
    const session = signedIn();
    const { calls } = renderApp(
      "/accounts/uid_123",
      {
        "GET /v1/admin/accounts/uid_123": () => ({ json: account }),
        "POST /v1/admin/accounts/uid_123/actions": () => {
          posts++;
          return posts === 1
            ? { status: 401, json: { success: false, error: "reauth_required", message: "confirm it's you", method: "passkey" } }
            : { json: { ...account, owed_cents: 0 } };
        },
        "POST /v1/admin/session/options": () => ({ json: { options: { publicKey: requestOptions }, expires_at: "2026-11-04T10:05:00Z" } }),
        "POST /v1/admin/session/verify": () => ({ json: { session: "sess_2" } }),
      },
      auth,
      session,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Write off $1.25…" }));
    await userEvent.click(screen.getByRole("button", { name: "Write off" }));
    const sheet = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(within(sheet).queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    await userEvent.click(within(sheet).getByRole("button", { name: "Use your passkey" }));
    await waitFor(() => expect(posts).toBe(2));
    expect(auth.reauthenticate).not.toHaveBeenCalled();
    expect(calls.find((c) => c.path === "/v1/admin/session/options")!.body).toEqual({ purpose: "reassert" });
    expect(calls.find((c) => c.path === "/v1/admin/session/verify")!.body).toMatchObject({ purpose: "reassert" });
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/actions")).at(-1)!.headers["X-Admin-Session"]).toBe("sess_2");
    await waitFor(() => expect(screen.queryByText("Owes $1.25")).toBeNull());
  });

  it("cancelling the passkey says nothing moved", async () => {
    renderApp(
      "/accounts/uid_123",
      {
        "GET /v1/admin/accounts/uid_123": () => ({ json: account }),
        "POST /v1/admin/accounts/uid_123/actions": () => ({
          status: 401,
          json: { success: false, error: "reauth_required", message: "again", method: "passkey" },
        }),
        "POST /v1/admin/session/options": () => ({ json: { options: { publicKey: requestOptions }, expires_at: "2026-11-04T10:05:00Z" } }),
      },
      googleDone(),
      signedIn(),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Write off $1.25…" }));
    await userEvent.click(screen.getByRole("button", { name: "Write off" }));
    const sheet = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(/Not confirmed. Nothing was charged or refunded./)).toBeInTheDocument();
  });
});

describe("Security: passkeys (ADR 0135)", () => {
  const keys = [
    { id: "pk_1", name: "Mac · Safari", created_at: "2026-11-01T10:00:00Z", last_used_at: "2026-11-04T09:00:00Z" },
    { id: "pk_2", name: "iPhone · Safari", created_at: "2026-11-02T10:00:00Z", last_used_at: null },
  ];
  const signedIn = () => {
    const session = new AdminSession(memoryStorage());
    session.set("sess_1");
    return session;
  };

  it("lists passkeys with created and last used", async () => {
    renderApp("/security", { "GET /v1/admin/passkeys": () => ({ json: { passkeys: keys } }) }, googleDone(), signedIn());
    const first = await screen.findByTestId("passkey-pk_1");
    expect(first).toHaveTextContent("Mac · Safari");
    expect(screen.getByTestId("passkey-pk_2")).toHaveTextContent("Never");
    expect(screen.getByRole("link", { name: "Security" })).toHaveAttribute("href", "/security");
  });

  it("adds a passkey after a fresh assertion", async () => {
    let list = [keys[0]];
    let regOptions = 0;
    const { calls } = renderApp(
      "/security",
      {
        "GET /v1/admin/passkeys": () => ({ json: { passkeys: list } }),
        "POST /v1/admin/passkeys/register/options": () => {
          regOptions++;
          return regOptions === 1
            ? { status: 401, json: { success: false, error: "reauth_required", message: "again", method: "passkey" } }
            : { json: { options: { publicKey: creationOptions }, expires_at: "2026-11-04T10:05:00Z" } };
        },
        "POST /v1/admin/passkeys/register/verify": ({ body }) => {
          list = [...list, { id: "pk_3", name: (body as { name: string }).name, created_at: "2026-11-04T10:00:00Z", last_used_at: null }];
          return { json: { passkey: list.at(-1) } };
        },
        "POST /v1/admin/session/options": () => ({ json: { options: { publicKey: requestOptions }, expires_at: "2026-11-04T10:05:00Z" } }),
        "POST /v1/admin/session/verify": () => ({ json: { session: "sess_2" } }),
      },
      googleDone(),
      signedIn(),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
    const sheet = screen.getByRole("dialog", { name: "Add a passkey" });
    const name = within(sheet).getByLabelText(/Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "YubiKey");
    await userEvent.click(within(sheet).getByRole("button", { name: "Add passkey" }));
    const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Use your passkey" }));
    expect(await screen.findByTestId("passkey-pk_3")).toHaveTextContent("YubiKey");
    expect(wa.get).toHaveBeenCalledTimes(1);
    expect(wa.create).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.path === "/v1/admin/passkeys/register/verify")!.body).toMatchObject({ name: "YubiKey" });
    expect(screen.getByRole("status")).toHaveTextContent("Passkey added.");
  });

  it("removes a passkey after a confirm", async () => {
    let list = keys;
    const { calls } = renderApp(
      "/security",
      {
        "GET /v1/admin/passkeys": () => ({ json: { passkeys: list } }),
        "DELETE /v1/admin/passkeys/pk_2": () => {
          list = [keys[0]];
          return { json: {} };
        },
      },
      googleDone(),
      signedIn(),
    );
    const row = await screen.findByTestId("passkey-pk_2");
    await userEvent.click(within(row).getByRole("button", { name: "Remove…" }));
    const confirm = screen.getByRole("alertdialog", { name: 'Remove "iPhone · Safari"?' });
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove passkey" }));
    await waitFor(() => expect(screen.queryByTestId("passkey-pk_2")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("the last passkey can't be removed", async () => {
    renderApp(
      "/security",
      {
        "GET /v1/admin/passkeys": () => ({ json: { passkeys: [keys[0]] } }),
        "DELETE /v1/admin/passkeys/pk_1": () => apiError(409, "last_passkey", "last one"),
      },
      googleDone(),
      signedIn(),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Remove…" }));
    const confirm = screen.getByRole("alertdialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove passkey" }));
    expect(await within(confirm).findByRole("alert")).toHaveTextContent("Add another passkey before removing this one.");
  });
});
