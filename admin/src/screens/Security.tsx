import { useState } from "react";

import { Button, ErrorState, Field, Sheet, SkeletonRows } from "../components/ui";
import { ApiError, errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import { createPasskey, deviceName, PASSKEY_COPY, passkeyErrorMessage } from "../lib/passkeys";
import { useServices } from "../lib/services";
import type { Passkey } from "../lib/types";
import { useLoad } from "../lib/useLoad";

/**
 * Security (ADR 0135): the passkeys on the admin account. Adding one needs
 * a fresh passkey assertion (401 reauth_required → the passkey, then the
 * add runs again); removing one asks first, and the last one can't go
 * (409 last_passkey).
 */
export function SecurityPage() {
  const { api, withReauth } = useServices();
  const { state, retry, set } = useLoad(() => api.listPasskeys(), [api]);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [flash, setFlash] = useState("");

  return (
    <>
      <div className="titlebar">
        <h1>Security</h1>
        <span className="muted small">Passkeys for signing in and confirming money actions</span>
        <span className="grow" />
        <Button variant="primary" onClick={() => setAdding(true)}>Add a passkey</Button>
      </div>
      {flash && <p className="ok small" role="status">{flash}</p>}
      {state.kind === "loading" && <SkeletonRows rows={2} cols={4} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the passkeys." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && (
        <section className="card">
          <div className="sh"><b>Passkeys</b><span className="xs muted">{PASSKEY_COPY}</span></div>
          {state.data.length === 0 ? (
            <p className="muted xs pad">No passkeys yet.</p>
          ) : (
            <table className="at" data-testid="passkeys">
              <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th /></tr></thead>
              <tbody>
                {state.data.map((p) => (
                  <tr key={p.id} data-testid={`passkey-${p.id}`}>
                    <td>{p.name}</td>
                    <td className="xs">{dateTime(p.created_at)}</td>
                    <td className="xs">{p.last_used_at ? dateTime(p.last_used_at) : "Never"}</td>
                    <td><Button size="sm" onClick={() => setRemoving(p)}>Remove…</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {adding && (
        <AddSheet
          onClose={() => setAdding(false)}
          onAdd={async (name) => {
            await withReauth(() => createPasskey(api, name));
            set(await api.listPasskeys());
            setAdding(false);
            setFlash("Passkey added.");
          }}
        />
      )}
      {removing && (
        <RemoveSheet
          passkey={removing}
          onClose={() => setRemoving(null)}
          onRemove={async () => {
            await withReauth(() => api.removePasskey(removing.id));
            set(await api.listPasskeys());
            setRemoving(null);
            setFlash("Passkey removed.");
          }}
        />
      )}
    </>
  );
}

function AddSheet({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string) => Promise<void> }) {
  const [name, setName] = useState(deviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      await onAdd(name.trim() || deviceName());
    } catch (e) {
      setError(passkeyErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="Add a passkey"
      subtitle={PASSKEY_COPY}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="lg" onClick={() => void go()} disabled={busy}>
            {busy ? "Waiting for the passkey…" : "Add passkey"}
          </Button>
        </>
      }
    >
      <Field label="Name" hint="So you can tell your passkeys apart, e.g. the device.">
        <input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <p className="muted small">You'll confirm with a passkey you already have first.</p>
      {error && <p className="err small" role="alert">{error}</p>}
    </Sheet>
  );
}

function RemoveSheet({ passkey, onClose, onRemove }: { passkey: Passkey; onClose: () => void; onRemove: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      await onRemove();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "last_passkey"
          ? "Add another passkey before removing this one."
          : passkeyErrorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      alert
      title={`Remove "${passkey.name}"?`}
      subtitle="It can't sign in to the console or confirm money actions any more. This can't be undone."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" size="lg" onClick={() => void go()} disabled={busy}>
            {busy ? "Removing…" : "Remove passkey"}
          </Button>
        </>
      }
    >
      {error && <p className="err small" role="alert">{error}</p>}
    </Sheet>
  );
}
