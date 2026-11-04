import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button, Sheet } from "../components/ui";
import { AdminApi, ApiError } from "./api";
import type { AdminAuth } from "./auth";
import { assertPasskey, PASSKEY_COPY, passkeyErrorMessage } from "./passkeys";

interface Services {
  api: AdminApi;
  auth: AdminAuth;
  email: string;
  /**
   * Runs a money action; on 401 reauth_required asks the owner to confirm
   * with the passkey (ADR 0135; a Google sign-in when the gateway names
   * {method: "google"}) and runs it once more.
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
  const [asking, setAsking] = useState<null | "passkey" | "google">(null);
  const pending = useRef<Pending | null>(null);

  const ask = useCallback(
    (how: "passkey" | "google") =>
      new Promise<void>((resolve, reject) => {
        pending.current = { resolve, reject };
        setAsking(how);
      }),
    [],
  );

  const withReauth = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      let how: "passkey" | "google";
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== "reauth_required") throw err;
        how = err.details?.method === "google" ? "google" : "passkey";
      }
      await ask(how);
      return fn();
    },
    [ask],
  );

  const finish = (err?: Error) => {
    const p = pending.current;
    pending.current = null;
    setAsking(null);
    if (err) p?.reject(err);
    else p?.resolve();
  };
  const cancelled = () => new ApiError(401, "reauth_cancelled", "Not confirmed. Nothing was charged or refunded.");

  const value = useMemo(() => ({ api, auth, email, withReauth }), [api, auth, email, withReauth]);
  return (
    <ServicesContext.Provider value={value}>
      {children}
      {asking === "google" && <ReauthSheet auth={auth} onDone={() => finish()} onCancel={() => finish(cancelled())} />}
      {asking === "passkey" && <PasskeyReauthSheet api={api} onDone={() => finish()} onCancel={() => finish(cancelled())} />}
    </ServicesContext.Provider>
  );
}

/** Re-assert with the passkey (ADR 0135), then the action runs again. The
 * options are fetched as the sheet opens so the prompt opens from the
 * click. */
function PasskeyReauthSheet({ api, onDone, onCancel }: { api: AdminApi; onDone: () => void; onCancel: () => void }) {
  const [options, setOptions] = useState<PublicKeyCredentialRequestOptionsJSON | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api.sessionOptions("reassert").then(setOptions, (e) => setError(passkeyErrorMessage(e)));
  }, [api]);
  useEffect(load, [load]);
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      await assertPasskey(api, "reassert", options ?? undefined);
      onDone();
    } catch (e) {
      setError(passkeyErrorMessage(e));
      setOptions(null);
      load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="Confirm it's you"
      subtitle="Money actions need your passkey within the last 5 minutes."
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void go()} disabled={busy}>
            {busy ? "Waiting for the passkey…" : "Use your passkey"}
          </Button>
        </>
      }
    >
      <p className="muted small">{PASSKEY_COPY} Then the action runs again.</p>
      {error && <p className="err small" role="alert">{error}</p>}
    </Sheet>
  );
}

/** A fresh Google sign-in, when the gateway asks for one
 * ({method: "google"}); then the action runs again. */
function ReauthSheet({ auth, onDone, onCancel }: { auth: AdminAuth; onDone: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      await auth.reauthenticate();
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
      subtitle="This needs a Google sign-in within the last 5 minutes."
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void start()} disabled={busy}>
            {busy ? "Working…" : "Sign in with Google"}
          </Button>
        </>
      }
    >
      <p className="muted small">Then the action runs again.</p>
      {error && <p className="err small" role="alert">{error}</p>}
    </Sheet>
  );
}
