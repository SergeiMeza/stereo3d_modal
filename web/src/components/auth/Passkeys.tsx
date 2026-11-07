"use client";

/**
 * Account → Sign-in & security: passkeys (ADR 0136). The list shows each
 * passkey's name, device, when it was added and last used, with Rename and
 * Remove (asked first). "Add a passkey" names it, then the browser makes
 * it. Adding needs a sign-in from the last 5 minutes: when the gateway
 * says so (401 reauth_required), the shared "Confirm it's you" sheet
 * (ReauthSheet) asks to sign in again, then the person presses Add again
 * (the passkey prompt has to come from a click).
 *
 * AddPasskeyDialog is shared with the suggestion after a sign-in.
 */

import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import { usePasskeysSupported } from "@/components/auth/PasskeySignIn";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GatewayError } from "@/lib/api/client";
import { confirmItsYou, isReauthCode } from "@/lib/reauth";
import { useGateway } from "@/lib/api/useGateway";
import { addPasskey, cancelPasskeyRequest, deviceName, toPasskeyError } from "@/lib/passkeys";
import type { Passkey } from "@/lib/passkeys";
import { billingUidAtom } from "@/lib/billing";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

import { dropPasskeyAtom, loadPasskeysAtom, passkeyListAtom, putPasskeyAtom } from "./passkeyAtoms";
import { useRegion } from "@/lib/useRegion";

const NAME_MAX = 60;

function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** 401 reauth_required {method: "firebase"}: the ID token's sign-in is
 * older than 5 minutes; sign in again with one of the account's ways. */
function needsReauth(e: unknown): boolean {
  return e instanceof GatewayError && isReauthCode(e.code);
}

function message(e: unknown): string {
  if (e instanceof GatewayError) {
    if (e.code === "passkey_exists") return "This device already has a passkey for your account.";
    return e.message;
  }
  return toPasskeyError(e).message;
}

export function PasskeysSection(): JSX.Element | null {
  const gateway = useGateway();
  const supported = usePasskeysSupported();
  const cn = useRegion() === "cn";
  // ADR 0138: the list lives in an app-store atom (passkeyAtoms)
  const state = useAppAtomValue(passkeyListAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const passkeys = state.uid === uid ? state.list : null;
  const loadError = state.uid === uid ? state.loadError : null;
  const loadPasskeys = useAppSetAtom(loadPasskeysAtom);
  const putPasskey = useAppSetAtom(putPasskeyAtom);
  const dropPasskey = useAppSetAtom(dropPasskeyAtom);
  const [adding, setAdding] = useState(false);
  // the passkey a dialog is for, by id (its row comes from the list)
  const [renamingId, setRenaming] = useState<string | null>(null);
  const [removingId, setRemoving] = useState<string | null>(null);
  const renaming = passkeys?.find((p) => p.id === renamingId) ?? null;
  const removing = passkeys?.find((p) => p.id === removingId) ?? null;
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => void loadPasskeys(gateway), [loadPasskeys, gateway]);

  // read on mount, and again when the account changes
  useEffect(() => {
    load();
  }, [load, uid]);

  if (cn) return null;

  return (
    <div data-testid="passkeys" className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-fg-muted">Passkeys</p>
          <p className="text-xs text-fg-muted">Sign in with Face ID, Touch ID, your phone or a security key.</p>
        </div>
        {supported && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)} data-testid="passkey-add">
            <KeyRound aria-hidden="true" />
            Add a passkey
          </Button>
        )}
      </div>

      {passkeys !== null && passkeys.length > 0 && (
        <ul className="divide-y divide-edge rounded-lg border border-edge">
          {passkeys.map((p) => (
            <li key={p.id} data-testid={`passkey-${p.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg">
                <KeyRound className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fg">{p.name}</p>
                <p className="text-xs text-fg-muted">
                  {[p.device_hint, `Added ${when(p.created_at)}`, `Last used ${when(p.last_used_at)}`].filter(Boolean).join(" · ")}
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button size="xs" variant="outline" onClick={() => setRenaming(p.id)} aria-label={`Rename ${p.name}`}>
                  Rename
                </Button>
                <Button size="xs" variant="outline" onClick={() => setRemoving(p.id)} aria-label={`Remove ${p.name}`}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {passkeys !== null && passkeys.length === 0 && (
        <p className="text-xs text-fg-muted">
          {supported ? "No passkeys yet." : "No passkeys yet. This browser can't add one."}
        </p>
      )}
      {loadError !== null && (
        <p role="alert" className="text-xs text-destructive">
          {loadError}
        </p>
      )}
      {notice !== null && <p role="status" className="text-xs text-chart-2">{notice}</p>}

      <AddPasskeyDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(p) => {
          setNotice("Passkey added.");
          // the gateway answers the new passkey (201): no refetch
          if (p) putPasskey(p);
          else load();
        }}
      />
      <RenamePasskeyDialog
        passkey={renaming}
        onClose={() => setRenaming(null)}
        onRenamed={(p) => {
          setNotice("Passkey renamed.");
          putPasskey(p);
        }}
      />
      <RemovePasskeyDialog
        passkey={removing}
        onClose={() => setRemoving(null)}
        onRemoved={(id) => {
          setNotice("Passkey removed.");
          dropPasskey(id);
        }}
      />
    </div>
  );
}

/** Name it, then the browser makes it; asks to sign in again first when
 * the sign-in is too old. */
export function AddPasskeyDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (p: Passkey | null) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-sm">
        {/* mounted per opening, so each one starts fresh */}
        <AddPasskeyBody
          busy={busy}
          setBusy={setBusy}
          onCancel={() => onOpenChange(false)}
          onAdded={(p) => {
            onOpenChange(false);
            onAdded(p);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function AddPasskeyBody({
  busy,
  setBusy,
  onCancel,
  onAdded,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  onCancel: () => void;
  onAdded: (p: Passkey | null) => void;
}): JSX.Element {
  const gateway = useGateway();
  const [name, setName] = useState(deviceName);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a prompt still open when the dialog goes is stopped (owner bug 2026-11-05)
  useEffect(() => () => cancelPasskeyRequest(), []);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      onAdded(await addPasskey(gateway, name.trim().slice(0, NAME_MAX) || deviceName()));
    } catch (e) {
      if (needsReauth(e)) {
        // owner 2026-11-06: the shared "Confirm it's you"; the passkey
        // prompt then has to come from the next press of Add
        setBusy(false);
        try {
          await confirmItsYou();
          setConfirmed(true);
        } catch {
          // not confirmed: nothing changed, the dialog stays
        }
      } else if (e instanceof GatewayError || !toPasskeyError(e).cancelled) setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a passkey</DialogTitle>
        <DialogDescription>
          Sign in next time with Face ID, Touch ID, your phone or a security key. Nothing to type.
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="passkey-name">Name</Label>
          <Input id="passkey-name" value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </div>
        {confirmed && <p className="text-xs text-chart-2">Signed in again. Now add the passkey.</p>}
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Waiting for your passkey…" : "Add passkey"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function RenamePasskeyDialog({
  passkey,
  onClose,
  onRenamed,
}: {
  passkey: Passkey | null;
  onClose: () => void;
  onRenamed: (p: Passkey) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={passkey !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-sm">
        {passkey !== null && (
          <RenameBody
            passkey={passkey}
            busy={busy}
            setBusy={setBusy}
            onCancel={onClose}
            onRenamed={(p) => {
              onClose();
              onRenamed(p);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameBody({
  passkey,
  busy,
  setBusy,
  onCancel,
  onRenamed,
}: {
  passkey: Passkey;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onCancel: () => void;
  onRenamed: (p: Passkey) => void;
}): JSX.Element {
  const gateway = useGateway();
  const [name, setName] = useState(passkey.name);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const renamed = await gateway.renamePasskey(passkey.id, name.trim());
      onRenamed(renamed ?? { ...passkey, name: name.trim() });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename passkey</DialogTitle>
        <DialogDescription>A name helps you tell your passkeys apart.</DialogDescription>
      </DialogHeader>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="passkey-rename">Name</Label>
          <Input id="passkey-rename" value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </div>
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || name.trim() === ""}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function RemovePasskeyDialog({
  passkey,
  onClose,
  onRemoved,
}: {
  passkey: Passkey | null;
  onClose: () => void;
  onRemoved: (id: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={passkey !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent>
        {passkey !== null && (
          <RemoveBody
            passkey={passkey}
            busy={busy}
            setBusy={setBusy}
            onRemoved={(id) => {
              onClose();
              onRemoved(id);
            }}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RemoveBody({
  passkey,
  busy,
  setBusy,
  onRemoved,
}: {
  passkey: Passkey;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onRemoved: (id: string) => void;
}): JSX.Element {
  const gateway = useGateway();
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await gateway.removePasskey(passkey.id);
      onRemoved(passkey.id);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Remove &quot;{passkey.name}&quot;?</AlertDialogTitle>
        <AlertDialogDescription>
          You won&apos;t be able to sign in with this passkey any more. You can still sign in another way.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
          {busy ? "Removing…" : "Remove passkey"}
        </Button>
      </AlertDialogFooter>
    </>
  );
}
