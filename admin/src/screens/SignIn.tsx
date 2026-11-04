import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";

import { Brand } from "../components/Brand";
import { Note } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, type AdminApi } from "../lib/api";
import type { AdminAuth, AuthState } from "../lib/auth";
import { assertPasskey, createPasskey, PASSKEY_COPY, passkeyErrorMessage } from "../lib/passkeys";

const ENV = import.meta.env.VITE_ENV_LABEL as string | undefined;

/** A0: Google, then the passkey (ADR 0135), and no access. */
export function SignInScreen({ auth, state, api }: { auth: AdminAuth; state: AuthState; api: AdminApi }) {
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <div className="flex w-[380px] max-w-full flex-col items-center gap-4 rounded-2xl bg-card px-7 py-8 text-center shadow-2xl ring-1 ring-foreground/10">
        <Brand big env={ENV} />
        <Body auth={auth} state={state} api={api} />
      </div>
    </main>
  );
}

function Body({ auth, state, api }: { auth: AdminAuth; state: AuthState; api: AdminApi }) {
  switch (state.kind) {
    case "loading":
      return <Spinner />;
    case "passkey":
      return <PasskeyStep auth={auth} api={api} email={state.email} />;
    case "signed_out":
      return <SignedOut auth={auth} state={state} />;
    case "no_access":
      return (
        <>
          <p>This account has no access.</p>
          <Note>{state.email}</Note>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void auth.recheck()}>Check again</Button>
            <Button size="sm" variant="ghost" onClick={() => void auth.signOut()}>Sign out</Button>
          </div>
        </>
      );
  }
}

function GoogleButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      className="flex h-11 w-full items-center justify-center gap-2.5 rounded-lg bg-white text-[14.5px] font-medium text-[#1f1f1f] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-progress disabled:opacity-60"
      onClick={onClick}
      disabled={busy}
    >
      <svg viewBox="0 0 48 48" aria-hidden="true" className="size-4.5">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
      {busy ? "Working…" : "Sign in with Google"}
    </button>
  );
}

function SignedOut({ auth, state }: { auth: AdminAuth; state: Extract<AuthState, { kind: "signed_out" }> }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await auth.signIn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {state.notice === "expired" && <p className="text-sm text-warning">Your session ended. Sign in again.</p>}
      <GoogleButton onClick={() => void go()} busy={busy} />
      {state.error && <Note tone="error">{state.error}</Note>}
    </>
  );
}

type PasskeyStage =
  | { kind: "checking" }
  | { kind: "use"; options: PublicKeyCredentialRequestOptionsJSON | null; added?: boolean }
  | { kind: "setup" };

/**
 * After Google: "Use your passkey". The options are fetched as the step
 * opens, so the browser's passkey prompt opens straight from the click.
 * No passkey on the account yet (409 no_passkey): "Set up a passkey", then
 * sign in with it. There is no other second factor (ADR 0135).
 */
function PasskeyStep({ auth, api, email }: { auth: AdminAuth; api: AdminApi; email: string }) {
  const [stage, setStage] = useState<PasskeyStage>({ kind: "checking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const prepare = async (added = false) => {
    setError("");
    try {
      const options = await api.sessionOptions("sign_in");
      setStage({ kind: "use", options, added });
    } catch (e) {
      if (e instanceof ApiError && e.code === "no_passkey") setStage({ kind: "setup" });
      else {
        setStage({ kind: "use", options: null, added });
        setError(passkeyErrorMessage(e));
      }
    }
  };

  useEffect(() => {
    void prepare();
    // once per mount: the step reopens after a sign-out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const use = async () => {
    if (stage.kind !== "use") return;
    setBusy(true);
    setError("");
    try {
      await assertPasskey(api, "sign_in", stage.options ?? undefined);
      // the session is set; the console opens
    } catch (e) {
      setError(passkeyErrorMessage(e));
      // a used or expired challenge can't be tried again
      void api.sessionOptions("sign_in").then(
        (options) => setStage({ kind: "use", options }),
        () => setStage({ kind: "use", options: null }),
      );
    } finally {
      setBusy(false);
    }
  };

  const setup = async () => {
    setBusy(true);
    setError("");
    try {
      try {
        await createPasskey(api);
      } catch (e) {
        // The first passkey needs a Google sign-in within 5 minutes
        // (401 reauth_required {method: "google"}): sign in again, retry once.
        if (!(e instanceof ApiError) || e.code !== "reauth_required" || e.details?.method === "passkey") throw e;
        await auth.reauthenticate();
        await createPasskey(api);
      }
      await prepare(true);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "passkey_exists"
          ? "This device already has a passkey for the console. Use it to sign in."
          : passkeyErrorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {stage.kind === "setup" ? (
        <>
          <p>Set up a passkey to use the console.</p>
          <Note>{email} · {PASSKEY_COPY}</Note>
          <Button variant="default" size="lg" className="w-full" onClick={() => void setup()} disabled={busy}>
            {busy ? "Waiting for the passkey…" : "Set up a passkey"}
          </Button>
        </>
      ) : (
        <>
          {stage.kind === "use" && stage.added && <p className="text-sm text-warning" role="status">Passkey added. Use it to sign in.</p>}
          <p>Use your passkey to finish signing in.</p>
          <Note>{email} · {PASSKEY_COPY}</Note>
          <Button variant="default" size="lg" className="w-full" onClick={() => void use()} disabled={busy || stage.kind === "checking"}>
            {busy ? "Waiting for the passkey…" : "Use your passkey"}
          </Button>
        </>
      )}
      {error && <Note tone="error">{error}</Note>}
      <Button size="sm" variant="ghost" onClick={() => void auth.signOut()}>Use another account</Button>
    </>
  );
}
