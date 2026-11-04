import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";

import { Modal, Note } from "@/components/common";
import { createQuery, useQuery } from "@/state/query";
import { apiOf, servicesAtom, useServicesAtom } from "@/state/services";
import { ApiError, type AdminApi, type PasskeyPurpose } from "./api";
import type { AdminAuth } from "./auth";
import { assertPasskey, PASSKEY_COPY, passkeyErrorMessage } from "./passkeys";

/**
 * The console's services and the re-assert step (ADR 0135), on atoms
 * (ADR 0138): the gateway client, the Google sign-in and the owner's email
 * come from servicesAtom; a pending "Confirm it's you" is reauthAtom, shown
 * by <ReauthHost /> in the shell.
 */

interface Services {
  api: AdminApi;
  auth: AdminAuth;
  email: string;
  /**
   * Runs a money action; on 401 reauth_required asks the owner to confirm
   * with the passkey (a Google sign-in when the gateway names
   * {method: "google"}) and runs it once more.
   */
  withReauth: <T>(fn: () => Promise<T>) => Promise<T>;
}

interface PendingReauth {
  how: "passkey" | "google";
  resolve: () => void;
  reject: (e: Error) => void;
}

/** The re-assert waiting for the owner, if any (memory only). */
export const reauthAtom = atom<PendingReauth | null>(null);

/** Session options (a fresh WebAuthn challenge) per purpose. */
/** A passkey challenge per purpose; single-use, so every opening loads anew. */
export const sessionOptionsQuery = createQuery<PasskeyPurpose, PublicKeyCredentialRequestOptionsJSON>(
  (get, purpose) => apiOf(get(servicesAtom)).sessionOptions(purpose),
  { fresh: true },
);

export function useServices(): Services {
  const { api, auth, email } = useServicesAtom();
  const setPending = useSetAtom(reauthAtom);
  const ask = useCallback(
    (how: "passkey" | "google") => new Promise<void>((resolve, reject) => setPending({ how, resolve, reject })),
    [setPending],
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
  return useMemo(() => ({ api, auth, email, withReauth }), [api, auth, email, withReauth]);
}

const cancelled = () => new ApiError(401, "reauth_cancelled", "Not confirmed. Nothing was charged or refunded.");

/** Shows the pending re-assert; rendered once in the shell. */
export function ReauthHost() {
  const pending = useAtomValue(reauthAtom);
  const setPending = useSetAtom(reauthAtom);
  const { api, auth } = useServicesAtom();
  if (!pending) return null;
  const finish = (err?: Error) => {
    setPending(null);
    if (err) pending.reject(err);
    else pending.resolve();
  };
  return pending.how === "google" ? (
    <ReauthSheet auth={auth} onDone={() => finish()} onCancel={() => finish(cancelled())} />
  ) : (
    <PasskeyReauthSheet api={api} onDone={() => finish()} onCancel={() => finish(cancelled())} />
  );
}

/** Re-assert with the passkey (ADR 0135), then the action runs again. The
 * options are fetched as the sheet opens so the prompt opens from the
 * click. */
function PasskeyReauthSheet({ api, onDone, onCancel }: { api: AdminApi; onDone: () => void; onCancel: () => void }) {
  const options = useQuery(sessionOptionsQuery, "reassert");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      await assertPasskey(api, "reassert", options.state.kind === "loaded" ? options.state.data : undefined);
      onDone();
    } catch (e) {
      setError(passkeyErrorMessage(e));
      // a used or expired challenge can't be tried again
      options.retry();
    } finally {
      setBusy(false);
    }
  };
  const shown = error || (options.state.kind === "error" ? passkeyErrorMessage(options.state.error) : "");
  return (
    <Modal
      title="Confirm it's you"
      subtitle="Money actions need your passkey within the last 5 minutes."
      onClose={onCancel}
      busy={busy}
      confirmLabel={busy ? "Waiting for the passkey…" : "Use your passkey"}
      onConfirm={() => void go()}
    >
      <Note>{PASSKEY_COPY} Then the action runs again.</Note>
      {shown && <Note tone="error">{shown}</Note>}
    </Modal>
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
    <Modal
      title="Confirm it's you"
      subtitle="This needs a Google sign-in within the last 5 minutes."
      onClose={onCancel}
      busy={busy}
      confirmLabel={busy ? "Working…" : "Sign in with Google"}
      onConfirm={() => void start()}
    >
      <Note>Then the action runs again.</Note>
      {error && <Note tone="error">{error}</Note>}
    </Modal>
  );
}
