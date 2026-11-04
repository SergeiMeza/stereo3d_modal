import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PasskeyButton, usePasskeyAutofill } from "@/components/auth/PasskeySignIn";
import { passkeySignIn } from "@/lib/passkeys";
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

const registered = () =>
  mockDb.passkeys.push({ id: "cred_1", name: "iPhone", device_hint: "iPhone", created_at: "2026-11-01T00:00:00Z", last_used_at: null });

/** The sign-in page's passkey parts, signing in with the gateway's token. */
function Harness({ onToken }: { onToken: (t: string | undefined) => void }) {
  const [error, setError] = useState("");
  const signIn = useCallback(
    async (opts?: { autofill?: boolean }) => {
      const a = await passkeySignIn(opts);
      onToken(a.custom_token);
    },
    [onToken],
  );
  const { autofill, restart } = usePasskeyAutofill(true, signIn, setError);
  return (
    <>
      <input aria-label="Email" autoComplete={autofill ? "username webauthn" : "email"} />
      <PasskeyButton signIn={signIn} onError={setError} onDone={restart} />
      {error && <p role="alert">{error}</p>}
    </>
  );
}

describe("passkey sign-in (ADR 0136)", () => {
  it("Sign in with a passkey: the prompt, the gateway's check, then its token", async () => {
    wa = installWebAuthn();
    registered();
    const onToken = vi.fn();
    render(<Harness onToken={onToken} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(onToken).toHaveBeenCalledWith("mock-custom-token"));
    expect(wa.get).toHaveBeenCalledTimes(1);
    expect(mockDb.passkeys[0].last_used_at).not.toBeNull();
  });

  it("a passkey that isn't registered here says to sign in another way", async () => {
    wa = installWebAuthn();
    render(<Harness onToken={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This passkey isn't registered here. Sign in another way.");
  });

  it("a closed prompt says nothing", async () => {
    wa = installWebAuthn();
    wa.fail.get = notAllowed();
    render(<Harness onToken={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in with a passkey" })).toHaveProperty("disabled", false));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("autofill: the email field offers passkeys, and the button takes over quietly", async () => {
    wa = installWebAuthn({ autofill: true });
    registered();
    const onToken = vi.fn();
    render(<Harness onToken={onToken} />);
    await waitFor(() => expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("username webauthn"));
    await waitFor(() => expect(wa!.get).toHaveBeenCalledTimes(1));
    expect((wa.get.mock.calls[0][0] as { mediation?: string }).mediation).toBe("conditional");
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(onToken).toHaveBeenCalledWith("mock-custom-token"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("no autofill where the browser can't", async () => {
    wa = installWebAuthn({ autofill: false });
    render(<Harness onToken={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("email");
    expect(wa.get).not.toHaveBeenCalled();
  });

  it("a browser without passkeys gets a plain message", async () => {
    await expect(passkeySignIn()).rejects.toMatchObject({ code: "unsupported" });
  });
});
