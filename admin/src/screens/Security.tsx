import { useState } from "react";
import { toast } from "sonner";

import { EmptyRow, ErrorState, Modal, Note, PageHeader, Panel, SkeletonRows } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, FieldControl, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import { createPasskey, deviceName, PASSKEY_COPY, passkeyErrorMessage } from "../lib/passkeys";
import { useServices } from "../lib/services";
import type { Passkey } from "../lib/types";
import { passkeysQuery } from "@/state/queries";
import { useQuery } from "@/state/query";

/**
 * Security (ADR 0135): the passkeys on the admin account. Adding one needs
 * a fresh passkey assertion (401 reauth_required → the passkey, then the
 * add runs again); removing one asks first, and the last one can't go
 * (409 last_passkey).
 */
export function SecurityPage() {
  const { api, withReauth } = useServices();
  const { state, retry, reload } = useQuery(passkeysQuery, null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Passkey | null>(null);

  return (
    <>
      <PageHeader title="Security" actions={<Button variant="default" onClick={() => setAdding(true)}>Add a passkey</Button>}>
        <span className="text-sm text-muted-foreground">Passkeys for signing in and confirming money actions</span>
      </PageHeader>
      {state.kind === "loading" && <SkeletonRows rows={2} cols={4} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the passkeys." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && (
        <Panel title="Passkeys" note={PASSKEY_COPY}>
          {state.data.length === 0 ? (
            <EmptyRow>No passkeys yet.</EmptyRow>
          ) : (
            <Table data-testid="passkeys">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead><TableHead>Created</TableHead><TableHead>Last used</TableHead>
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data.map((p) => (
                  <TableRow key={p.id} data-testid={`passkey-${p.id}`}>
                    <TableCell className="max-w-72 truncate">{p.name}</TableCell>
                    <TableCell className="text-xs">{dateTime(p.created_at)}</TableCell>
                    <TableCell className="text-xs">{p.last_used_at ? dateTime(p.last_used_at) : "Never"}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" aria-label={`Remove ${p.name}`} onClick={() => setRemoving(p)}>
                        Remove…
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      )}
      {adding && (
        <AddSheet
          onClose={() => setAdding(false)}
          onAdd={async (name) => {
            await withReauth(() => createPasskey(api, name));
            await reload();
            setAdding(false);
            toast.success("Passkey added.");
          }}
        />
      )}
      {removing && (
        <RemoveSheet
          passkey={removing}
          onClose={() => setRemoving(null)}
          onRemove={async () => {
            await withReauth(() => api.removePasskey(removing.id));
            await reload();
            setRemoving(null);
            toast.success("Passkey removed.");
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
    <Modal
      title="Add a passkey"
      subtitle={PASSKEY_COPY}
      onClose={onClose}
      busy={busy}
      confirmLabel={busy ? "Waiting for the passkey…" : "Add passkey"}
      onConfirm={() => void go()}
    >
      <Field>
        <FieldLabel>Name</FieldLabel>
        <FieldControl>
          <Input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </FieldControl>
        <FieldDescription>So you can tell your passkeys apart, e.g. the device.</FieldDescription>
      </Field>
      <Note>You'll confirm with a passkey you already have first.</Note>
      {error && <Note tone="error">{error}</Note>}
    </Modal>
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
    <Modal
      kind="alert"
      title={`Remove "${passkey.name}"?`}
      subtitle="It can't sign in to the console or confirm money actions any more. This can't be undone."
      onClose={onClose}
      busy={busy}
      confirmLabel={busy ? "Removing…" : "Remove passkey"}
      confirmVariant="destructive"
      onConfirm={() => void go()}
    >
      {error && <Note tone="error">{error}</Note>}
    </Modal>
  );
}
