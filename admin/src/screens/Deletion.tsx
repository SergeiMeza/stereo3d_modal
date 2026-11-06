import { useSetAtom } from "jotai";
import { useState } from "react";
import { toast } from "sonner";

import { Modal, Note, Panel, type Tone } from "@/components/common";
import { PasskeyNote } from "@/components/PasskeyNote";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { errorMessage } from "../lib/api";
import { dateTime, words } from "../lib/format";
import { useServices } from "../lib/services";
import { accountQuery } from "@/state/queries";
import type { AccountPage, AdminDeletion } from "../lib/types";

/**
 * The 48-hour deletion (gateway 00166) on an account page: when it goes,
 * when it was asked and from where, and whether the scheduled run is
 * blocked (it stays pending and is tried again). While pending: Cancel
 * deletion, and Process now (a fresh sign-in). A cancelled or finished
 * deletion stays as a record.
 */

export const DELETION_STATE: Record<AdminDeletion["state"], { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "amber" },
  cancelled: { label: "Cancelled", tone: "muted" },
  done: { label: "Deleted", tone: "red" },
};

export function deletionState(d: AdminDeletion): { label: string; tone: Tone } {
  if (d.state === "pending" && d.blocked) return { label: "Blocked", tone: "red" };
  return DELETION_STATE[d.state] ?? { label: words(d.state), tone: "plain" };
}

type Action = "cancel_deletion" | "process_deletion_now";

const COPY: Record<Action, { title: string; body: string; button: string; done: string }> = {
  cancel_deletion: {
    title: "Cancel deletion",
    body: "The account stays and works as before. They get the \"won't be deleted\" mail.",
    button: "Cancel deletion",
    done: "Deletion cancelled.",
  },
  process_deletion_now: {
    title: "Delete it now",
    body: "Deletes the account now instead of at its time. This can't be undone.",
    button: "Delete now",
    done: "Deletion processed.",
  },
};

export function DeletionSection({ page }: { page: AccountPage }) {
  const d = page.deletion;
  const [action, setAction] = useState<Action | null>(null);
  if (!d) return null;
  const st = deletionState(d);
  const pending = d.state === "pending";
  return (
    <Panel
      title="Account deletion"
      note={pending ? `deletes ${dateTime(d.delete_after)}` : undefined}
      data-testid="deletion"
      action={
        pending ? (
          <div className="flex gap-2">
            <Button onClick={() => setAction("cancel_deletion")}>Cancel deletion…</Button>
            <Button variant="destructive" onClick={() => setAction("process_deletion_now")}>
              Process now…
            </Button>
          </div>
        ) : undefined
      }
    >
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">State</dt>
        <dd>
          <Badge variant={st.tone} data-testid="deletion-state">
            {st.label}
          </Badge>
        </dd>
        <dt className="text-muted-foreground">Deletes</dt>
        <dd data-testid="deletion-after">{dateTime(d.delete_after)}</dd>
        <dt className="text-muted-foreground">Asked</dt>
        <dd>
          {dateTime(d.requested_at)}
          {d.source ? ` · ${words(d.source)}` : ""}
          {d.balance_confirmed ? " · balance refund confirmed" : ""}
        </dd>
        {d.blocked ? (
          <>
            <dt className="text-muted-foreground">Blocked</dt>
            <dd data-testid="deletion-blocked">
              {d.blocked_reason ? words(d.blocked_reason) : "yes"}
              {typeof d.attempts === "number" ? ` · ${d.attempts} ${d.attempts === 1 ? "attempt" : "attempts"}` : ""}
              {d.next_attempt_at ? ` · next ${dateTime(d.next_attempt_at)}` : ""}
            </dd>
          </>
        ) : null}
        {d.cancelled_at ? (
          <>
            <dt className="text-muted-foreground">Cancelled</dt>
            <dd>
              {dateTime(d.cancelled_at)}
              {d.cancelled_by ? ` · ${d.cancelled_by}` : ""}
            </dd>
          </>
        ) : null}
        {d.processed_at ? (
          <>
            <dt className="text-muted-foreground">Processed</dt>
            <dd>
              {dateTime(d.processed_at)}
              {d.processed_by ? ` · ${d.processed_by}` : ""}
              {d.outcome ? ` · ${words(d.outcome)}` : ""}
            </dd>
          </>
        ) : null}
      </dl>
      {action ? <DeletionActionSheet page={page} action={action} onClose={() => setAction(null)} /> : null}
    </Panel>
  );
}

function DeletionActionSheet({ page, action, onClose }: { page: AccountPage; action: Action; onClose: () => void }) {
  const { api, withReauth } = useServices();
  const updateAccount = useSetAtom(accountQuery.update);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copy = COPY[action];
  const uid = page.account.uid;

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await withReauth(() => api.deletionAction(uid, action));
      // the whole page back, or only the deletion (no billing record)
      updateAccount(uid, (p) => ("account" in r ? r : { ...p, deletion: r.deletion }));
      toast.success(copy.done);
      onClose();
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg.startsWith("That didn't work") || msg.startsWith("Not confirmed") ? msg : `That didn't work: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      kind="alert"
      title={copy.title}
      subtitle={page.account.email || uid}
      onClose={onClose}
      busy={busy}
      confirmLabel={busy ? "Working…" : copy.button}
      confirmVariant={action === "process_deletion_now" ? "destructive" : "default"}
      onConfirm={() => void confirm()}
    >
      <p className="text-sm">{copy.body}</p>
      {action === "process_deletion_now" && <PasskeyNote />}
      {error && <Note tone="error">{error}</Note>}
    </Modal>
  );
}
