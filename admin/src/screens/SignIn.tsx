import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";

import { Brand } from "../components/Brand";
import { Button, Field, Spinner } from "../components/ui";
import { ApiError, type AdminApi } from "../lib/api";
import type { AdminAuth, AuthState, Enrolment } from "../lib/auth";
import { assertPasskey, createPasskey, PASSKEY_COPY, passkeyErrorMessage } from "../lib/passkeys";

const ENV = import.meta.env.VITE_ENV_LABEL as string | undefined;

/** A0: sign-in, the passkey (ADR 0135), the code step, second-factor
 * enrolment and no access. */
export function SignInScreen({ auth, state, api }: { auth: AdminAuth; state: AuthState; api: AdminApi }) {
  return (
    <main className="signin">
      <div className="signin-card">
        <Brand big env={ENV} />
        <Body auth={auth} state={state} api={api} />
      </div>
    </main>
  );
}

function Body({ auth, state, api }: { auth: AdminAuth; state: AuthState; api: AdminApi }) {
  switch (state.kind) {
    case "passkey":
      return (
        <PasskeyStep
          auth={auth}
          api={api}
          email={state.email}
          hasFactor={state.hasFactor}
          totp={!state.methods || state.methods.includes("totp")}
        />
      );
    case "loading":
    case "ready":
      return <Spinner />;
    case "signed_out":
      return <SignedOut auth={auth} state={state} />;
    case "code":
      return <CodeStep auth={auth} label={state.label} error={state.error} />;
    case "enrol":
      return <Enrol auth={auth} email={state.email} hasFactor={state.hasFactor} />;
    case "no_access":
      return (
        <>
          <p>This account has no access.</p>
          <p className="muted small">{state.email}</p>
          <div className="row gap8">
            <Button size="sm" onClick={() => void auth.recheck()}>Check again</Button>
            <Button size="sm" variant="ghost" onClick={() => void auth.signOut()}>Sign out</Button>
          </div>
        </>
      );
  }
}

function GoogleButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button type="button" className="gbtn" onClick={onClick} disabled={busy}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
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
      {state.notice === "expired" && <p className="notice">Your session ended. Sign in again.</p>}
      {state.notice === "enrolled" && (
        <p className="notice">Second factor added. Sign in again, then enter a code from the app.</p>
      )}
      <GoogleButton onClick={() => void go()} busy={busy} />
      {state.error && <p className="err small" role="alert">{state.error}</p>}
    </>
  );
}

function CodeInput({
  value,
  onChange,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
}) {
  return (
    <input
      className="input mono code"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={8}
      autoFocus
      aria-label="Code"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
      onKeyDown={(e) => e.key === "Enter" && value.length >= 6 && onEnter()}
    />
  );
}

function CodeStep({ auth, label, error }: { auth: AdminAuth; label: string; error?: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await auth.submitCode(code);
    } finally {
      setBusy(false);
      setCode("");
    }
  };
  return (
    <>
      <p>Enter the code from your authenticator app.</p>
      <p className="muted small">{label}</p>
      <CodeInput value={code} onChange={setCode} onEnter={() => void submit()} />
      <Button variant="primary" className="full" onClick={() => void submit()} disabled={busy || code.length < 6}>
        {busy ? "Working…" : "Continue"}
      </Button>
      {error && <p className="err small" role="alert">{error}</p>}
      <Button size="sm" variant="ghost" onClick={() => void auth.signOut()}>Use another account</Button>
    </>
  );
}

type PasskeyStage =
  | { kind: "checking" }
  | { kind: "use"; options: PublicKeyCredentialRequestOptionsJSON | null; added?: boolean }
  | { kind: "setup" }
  | { kind: "totp" };

/**
 * After Google: "Use your passkey". The options are fetched as the step
 * opens, so the browser's passkey prompt opens straight from the click.
 * No passkey on the account yet (409 no_passkey): "Set up a passkey", then
 * sign in with it. The authenticator code stays one link away while the
 * gateway still takes it.
 */
function PasskeyStep({
  auth,
  api,
  email,
  hasFactor,
  totp,
}: {
  auth: AdminAuth;
  api: AdminApi;
  email: string;
  hasFactor: boolean;
  /** the gateway still takes the authenticator code */
  totp: boolean;
}) {
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
        if ((await auth.reauthenticate()) === "code") throw new Error("Finish with your authenticator code, then set up the passkey.");
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

  if (stage.kind === "totp") {
    return (
      <>
        <Enrol auth={auth} email={email} hasFactor={hasFactor} />
        <Button size="sm" variant="ghost" onClick={() => {
            setStage({ kind: "checking" });
            void prepare();
          }}>
          Use a passkey instead
        </Button>
      </>
    );
  }

  return (
    <>
      {stage.kind === "setup" ? (
        <>
          <p>Set up a passkey to use the console.</p>
          <p className="muted small">{email} · {PASSKEY_COPY}</p>
          <Button variant="primary" className="full" onClick={() => void setup()} disabled={busy}>
            {busy ? "Waiting for the passkey…" : "Set up a passkey"}
          </Button>
        </>
      ) : (
        <>
          {stage.kind === "use" && stage.added && <p className="notice">Passkey added. Use it to sign in.</p>}
          <p>Use your passkey to finish signing in.</p>
          <p className="muted small">{email} · {PASSKEY_COPY}</p>
          <Button variant="primary" className="full" onClick={() => void use()} disabled={busy || stage.kind === "checking"}>
            {busy ? "Waiting for the passkey…" : "Use your passkey"}
          </Button>
        </>
      )}
      {error && <p className="err small" role="alert">{error}</p>}
      {totp && (
        <Button size="sm" variant="ghost" onClick={() => setStage({ kind: "totp" })}>
          Use an authenticator code instead
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => void auth.signOut()}>Use another account</Button>
    </>
  );
}

function Enrol({ auth, email, hasFactor }: { auth: AdminAuth; email: string; hasFactor: boolean }) {
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (hasFactor) {
    return (
      <>
        <p>Sign in again with your second factor.</p>
        <p className="muted small">{email} has an authenticator app, but this session was started without it.</p>
        <Button variant="primary" onClick={() => void auth.signOut()}>Sign in again</Button>
      </>
    );
  }

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      setEnrolment(await auth.startEnrolment());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    setBusy(true);
    setError("");
    try {
      await auth.finishEnrolment(code);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <p>Add a second factor to use the console.</p>
      <p className="muted small">
        {email} · The console needs an authenticator app (1Password, Google Authenticator, Authy…).
      </p>
      {!enrolment ? (
        <Button variant="primary" onClick={() => void start()} disabled={busy}>
          {busy ? "Working…" : "Set up an authenticator app"}
        </Button>
      ) : (
        <>
          <img className="qr" src={enrolment.qrDataUrl} alt="QR code for your authenticator app" width={208} height={208} />
          <Field label="Or enter this key">
            <code className="secret">{enrolment.secretKey}</code>
          </Field>
          <Field label="Code from the app">
            <CodeInput value={code} onChange={setCode} onEnter={() => void finish()} />
          </Field>
          <Button variant="primary" className="full" onClick={() => void finish()} disabled={busy || code.length < 6}>
            {busy ? "Working…" : "Turn on"}
          </Button>
        </>
      )}
      {error && <p className="err small" role="alert">{error}</p>}
      <Button size="sm" variant="ghost" onClick={() => void auth.signOut()}>Sign out</Button>
    </>
  );
}
