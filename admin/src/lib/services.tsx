import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button, Field, Sheet } from "../components/ui";
import { AdminApi, ApiError } from "./api";
import type { AdminAuth } from "./auth";

interface Services {
  api: AdminApi;
  auth: AdminAuth;
  email: string;
  /**
   * Runs a money action; on 401 reauth_required asks the owner to sign in
   * again (Google, then the code) and runs it once more.
   */
  withReauth: <T>(fn: () => Promise<T>) => Promise<T>;
}

const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const v = useContext(ServicesContext);
  if (!v) throw new Error("useServices outside ServicesProvider");
  return v;
}

type Pending = { resolve: () => void; reject: (e: Error) => void };

export function ServicesProvider({
  api,
  auth,
  email,
  children,
}: {
  api: AdminApi;
  auth: AdminAuth;
  email: string;
  children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const pending = useRef<Pending | null>(null);

  const ask = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.current = { resolve, reject };
        setAsking(true);
      }),
    [],
  );

  const withReauth = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== "reauth_required") throw err;
      }
      await ask();
      return fn();
    },
    [ask],
  );

  const finish = (err?: Error) => {
    const p = pending.current;
    pending.current = null;
    setAsking(false);
    if (err) p?.reject(err);
    else p?.resolve();
  };

  const value = useMemo(() => ({ api, auth, email, withReauth }), [api, auth, email, withReauth]);
  return (
    <ServicesContext.Provider value={value}>
      {children}
      {asking && (
        <ReauthSheet
          auth={auth}
          onDone={() => finish()}
          onCancel={() =>
            finish(new ApiError(401, "reauth_cancelled", "Not confirmed. Nothing was charged or refunded."))
          }
        />
      )}
    </ServicesContext.Provider>
  );
}

function ReauthSheet({
  auth,
  onDone,
  onCancel,
}: {
  auth: AdminAuth;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"start" | "code">("start");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await auth.reauthenticate();
      if (r === "done") onDone();
      else setStep("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await auth.submitReauthCode(code);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Confirm it's you"
      subtitle="Money actions need a sign-in within the last 5 minutes."
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          {step === "start" ? (
            <Button variant="primary" onClick={start} disabled={busy}>
              {busy ? "Working…" : "Sign in with Google"}
            </Button>
          ) : (
            <Button variant="primary" onClick={submit} disabled={busy || code.trim().length < 6}>
              {busy ? "Working…" : "Confirm"}
            </Button>
          )}
        </>
      }
    >
      {step === "code" && (
        <Field label="Code from your authenticator app">
          <input
            className="input mono"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && code.length >= 6 && void submit()}
          />
        </Field>
      )}
      {step === "start" && <p className="muted small">Then the action runs again.</p>}
      {error && <p className="err small" role="alert">{error}</p>}
    </Sheet>
  );
}
