import { screen, waitFor } from "@testing-library/react";
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
        "POST /v1/admin/session/options": () => ({ json: { options: requestOptions } }),
        "POST /v1/admin/session/verify": () => ({ json: { session: "sess_1", expires_at: "2026-11-04T20:00:00Z" } }),
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
            ? { json: { options: requestOptions } }
            : apiError(409, "no_passkey", "No passkey on this account yet."),
        "POST /v1/admin/passkeys/register/options": () => ({ json: { options: creationOptions } }),
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
          return { json: { options: requestOptions } };
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
    renderApp("/cases", { "POST /v1/admin/session/options": () => ({ json: { options: requestOptions } }) }, googleDone());
    await userEvent.click(await screen.findByRole("button", { name: "Use an authenticator code instead" }));
    expect(screen.getByRole("button", { name: "Set up an authenticator app" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use a passkey instead" }));
    expect(await screen.findByRole("button", { name: "Use your passkey" })).toBeInTheDocument();
  });

  it("an ended passkey session asks for the passkey again", async () => {
    const session = new AdminSession(memoryStorage());
    session.set("sess_old");
    renderApp(
      "/cases",
      {
        "GET /v1/admin/cases": () => apiError(401, "session_expired", "Your passkey session ended."),
        "POST /v1/admin/session/options": () => ({ json: { options: requestOptions } }),
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
