import { useState } from "react";
import { toast } from "sonner";

import { EmptyRow, FilterSelect, Modal, Note, Panel, type Tone } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldControl, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, errorMessage } from "../lib/api";
import { dateOnly, dateTime, words } from "../lib/format";
import { useServices } from "../lib/services";
import { Link, paths } from "../lib/router";
import type { AccountPage as AccountPageData, Grant, GrantBody, GrantStatus, PromoGrant, PromoRegrant } from "../lib/types";

/**
 * Grant Pro (gateway 00106): give an account Pro, Business or Studio until
 * a date, with a reason; the grants table with Revoke (reason required).
 * Granting and revoking ask for a fresh sign-in when the gateway says so
 * (401 reauth_required). A failed grant (502 grant_failed) stays in the
 * list as failed with the gateway's message.
 */

const STATUS: Record<GrantStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "green" },
  granting: { label: "Granting", tone: "blue" },
  expired: { label: "Expired", tone: "muted" },
  revoked: { label: "Revoked", tone: "amber" },
  failed: { label: "Failed", tone: "red" },
};

const ENTITLEMENTS: { id: GrantBody["entitlement"]; label: string }[] = [
  { id: "pro", label: "Pro" },
  { id: "business", label: "Business" },
  { id: "studio", label: "Studio" },
];

/** "pro" → "Pro", "some_state" → "Some state". */
function label(v: string): string {
  const w = words(v);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

type Preset = "1w" | "1m" | "3m" | "custom";

const PRESETS: { id: Preset; label: string }[] = [
  { id: "1w", label: "1 week" },
  { id: "1m", label: "1 month" },
  { id: "3m", label: "3 months" },
  { id: "custom", label: "Custom" },
];

/** The end date for a preset, from now. */
export function presetEnd(p: Exclude<Preset, "custom">, now = new Date()): Date {
  const d = new Date(now);
  if (p === "1w") d.setUTCDate(d.getUTCDate() + 7);
  if (p === "1m") d.setUTCMonth(d.getUTCMonth() + 1);
  if (p === "3m") d.setUTCMonth(d.getUTCMonth() + 3);
  return d;
}

/** The gateway's window: 1 hour to 5 years ahead. */
export function endInRange(d: Date, now = new Date()): boolean {
  const min = now.getTime() + 3_600_000;
  const max = new Date(now);
  max.setUTCFullYear(max.getUTCFullYear() + 5);
  return d.getTime() >= min && d.getTime() <= max.getTime();
}

export function GrantsSection({ uid, initial }: { uid: string; initial: Grant[] }) {
  const [grants, setGrants] = useState<Grant[]>(initial);
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const upsert = (g: Grant) =>
    setGrants((list) => [g, ...list.filter((x) => x.id !== g.id)].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));

  return (
    <Panel
      title="Grants"
      note="Pro, Business or Studio given by us"
      action={<Button variant="default" onClick={() => setGranting(true)}>Grant Pro…</Button>}
      data-testid="grants"
    >
      {grants.length === 0 ? (
        <EmptyRow>No grants.</EmptyRow>
      ) : (
        <Table data-testid="grants-table">
          <TableHeader>
            <TableRow>
              <TableHead>Entitlement</TableHead>
              <TableHead>Ends</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>By</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Created</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.map((g) => {
              const st = STATUS[g.status] ?? { label: label(g.status), tone: "plain" as Tone };
              return (
                <TableRow key={g.id} data-testid={`grant-${g.id}`}>
                  <TableCell>{label(g.entitlement)}</TableCell>
                  <TableCell>{dateOnly(g.ends_at)}</TableCell>
                  <TableCell>
                    <Badge variant={st.tone}>{st.label}</Badge>
                    {g.status === "failed" && g.rc_error ? <div className="text-xs text-muted-foreground">{g.rc_error}</div> : null}
                    {g.status === "revoked" && g.revoke_reason ? (
                      <div className="text-xs text-muted-foreground">
                        {g.revoked_by ? `${g.revoked_by}: ` : ""}
                        {g.revoke_reason}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">{g.granted_by}</TableCell>
                  <TableCell className="text-xs whitespace-normal">{g.reason}</TableCell>
                  <TableCell className="text-xs">{dateTime(g.created_at)}</TableCell>
                  <TableCell>
                    {g.status === "active" || g.status === "granting" ? (
                      <Button size="sm" onClick={() => setRevoking(g)}>Revoke…</Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {granting && (
        <GrantSheet
          uid={uid}
          onClose={() => setGranting(false)}
          onResult={(g, message, ok) => {
            upsert(g);
            setGranting(false);
            if (ok) toast.success(message);
            else toast.error(message);
          }}
        />
      )}
      {revoking && (
        <RevokeSheet
          uid={uid}
          grant={revoking}
          onClose={() => setRevoking(null)}
          onDone={(g, partial) => {
            upsert(g);
            setRevoking(null);
            toast.success(partial ? "Revoked. Some grants will be retried tonight." : "Revoked.");
          }}
        />
      )}
    </Panel>
  );
}

function GrantSheet({
  uid,
  onClose,
  onResult,
}: {
  uid: string;
  onClose: () => void;
  onResult: (g: Grant, message: string, ok: boolean) => void;
}) {
  const { api, withReauth } = useServices();
  const [entitlement, setEntitlement] = useState<GrantBody["entitlement"]>("pro");
  const [preset, setPreset] = useState<Preset>("1m");
  const [custom, setCustom] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const end = preset === "custom" ? (custom ? new Date(`${custom}T23:59:00Z`) : null) : presetEnd(preset);
  const endOk = end !== null && !Number.isNaN(end.getTime()) && endInRange(end);
  const ready = endOk && reason.trim().length > 0 && reason.length <= 500;

  const confirm = async () => {
    if (!end) return;
    setBusy(true);
    setError("");
    try {
      const g = await withReauth(() =>
        api.createGrant(uid, { entitlement, ends_at: end.toISOString(), reason: reason.trim() }),
      );
      onResult(g, `${label(entitlement)} granted until ${dateOnly(g.ends_at)}.`, true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "grant_failed") {
        // the record stays, as failed, with the gateway's message
        const g = err.details?.grant as Grant | undefined;
        if (g) {
          onResult(g, `Not granted: ${err.message}`, false);
          return;
        }
      }
      if (err instanceof ApiError && err.code === "rc_unavailable") {
        setError("The subscription service isn't answering. Nothing was granted. Try again in a few minutes.");
      } else if (err instanceof ApiError && err.code === "no_account") {
        setError("No account with that ID.");
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      kind="alert"
      title="Grant Pro"
      subtitle={uid}
      onClose={onClose}
      busy={busy}
      confirmLabel={busy ? "Granting…" : `Grant ${label(entitlement)}`}
      onConfirm={() => void confirm()}
      confirmDisabled={!ready}
    >
      <Field>
        <FieldLabel>Entitlement</FieldLabel>
        <FieldControl>
          <FilterSelect
            label="Entitlement"
            size="default"
            className="w-full"
            value={entitlement}
            onChange={(v) => setEntitlement(v as GrantBody["entitlement"])}
            options={ENTITLEMENTS.map((e) => ({ value: e.id, label: e.label }))}
          />
        </FieldControl>
      </Field>
      <FieldSet>
        <FieldLegend>Ends</FieldLegend>
        <RadioGroup value={preset} onValueChange={(v) => setPreset(v as Preset)} aria-label="Ends" className="flex flex-wrap gap-x-4">
          {PRESETS.map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <RadioGroupItem value={p.id} id={`ends-${p.id}`} />
              <Label htmlFor={`ends-${p.id}`} className="text-sm text-foreground">{p.label}</Label>
            </div>
          ))}
        </RadioGroup>
      </FieldSet>
      {preset === "custom" ? (
        <Field>
          <FieldLabel>End date</FieldLabel>
          <FieldControl>
            <Input type="date" value={custom} onChange={(e) => setCustom(e.target.value)} />
          </FieldControl>
          <FieldDescription>1 hour to 5 years from now</FieldDescription>
          <FieldError>{custom && !endOk ? "Pick a date from 1 hour to 5 years ahead." : null}</FieldError>
        </Field>
      ) : null}
      {end && endOk ? (
        <span className="text-2xs text-muted-foreground" data-testid="grant-ends">Ends {dateOnly(end.toISOString())}</span>
      ) : null}
      <Field>
        <FieldLabel>Reason</FieldLabel>
        <FieldControl>
          <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FieldControl>
        <FieldDescription>Required. Up to 500 characters.</FieldDescription>
      </Field>
      {error && <Note tone="error">{error}</Note>}
    </Modal>
  );
}

function RevokeSheet({
  uid,
  grant,
  onClose,
  onDone,
}: {
  uid: string;
  grant: Grant;
  onClose: () => void;
  onDone: (g: Grant, partial: boolean) => void;
}) {
  const { api, withReauth } = useServices();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await withReauth(() => api.revokeGrant(uid, grant.id, reason.trim()));
      onDone(r.grant, r.partial);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "grant_not_active"
          ? "This grant isn't active any more."
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      kind="alert"
      title={`Revoke ${label(grant.entitlement)}`}
      subtitle={`Granted until ${dateOnly(grant.ends_at)} by ${grant.granted_by}`}
      onClose={onClose}
      busy={busy}
      confirmLabel={busy ? "Revoking…" : "Revoke"}
      confirmVariant="destructive"
      onConfirm={() => void confirm()}
      confirmDisabled={!reason.trim()}
    >
      <p className="text-sm">The account loses this entitlement now. Other grants and purchases stay.</p>
      <Field>
        <FieldLabel>Reason</FieldLabel>
        <FieldControl>
          <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FieldControl>
        <FieldDescription>Required.</FieldDescription>
      </Field>
      {error && <Note tone="error">{error}</Note>}
    </Modal>
  );
}

const PROMO_TONE: Record<string, Tone> = {
  done: "green",
  held: "amber",
  kept_removed: "red",
  merged: "muted",
  started: "blue",
  snapshotted: "blue",
  regranting: "blue",
  snapshot_failed: "red",
  revoke_failed: "red",
  regrant_failed: "red",
};

function grantList(gs: PromoGrant[] | null | undefined): string {
  if (!gs || gs.length === 0) return "—";
  return gs.map((g) => `${label(g.entitlement)} ${g.expires_at ? `until ${dateOnly(g.expires_at)}` : "lifetime"}`).join(", ");
}

/** What the event key says: refund:in_… | dispute:dp_… | efw:… | end:… */
function eventLabel(ev: string): string {
  const [kind] = ev.split(":");
  return { refund: "Refund", dispute: "Dispute", efw: "Fraud warning", end: "Plan ended" }[kind] ?? label(kind);
}

/**
 * Re-grants: promotional grants a refund, dispute, fraud warning or plan
 * end took away, and what came back. After a lost dispute (kept_removed)
 * or while one is held, the owner can restore them with a reason
 * (admin action restore_promo_grants, fresh sign-in).
 */
export function PromoRegrants({
  uid,
  rows,
  onPage,
}: {
  uid: string;
  rows: PromoRegrant[];
  onPage: (p: AccountPageData) => void;
}) {
  const [restoring, setRestoring] = useState(false);
  if (rows.length === 0) return null;
  const restorable = rows.some((r) => r.status === "kept_removed" || r.status === "held");
  return (
    <Panel
      title="Re-grants"
      note="promotional grants taken away by a refund, dispute or fraud warning"
      action={restorable && <Button onClick={() => setRestoring(true)}>Restore promotional grants…</Button>}
      data-testid="promo-regrants"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Event</TableHead><TableHead>Status</TableHead><TableHead>Taken</TableHead><TableHead>Given back</TableHead>
            <TableHead>Skipped</TableHead><TableHead>Case</TableHead><TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} data-testid={`regrant-${r.id}`}>
              <TableCell>{eventLabel(r.event)}</TableCell>
              <TableCell>
                <Badge variant={PROMO_TONE[r.status] ?? "plain"}>{label(r.status)}</Badge>
                {r.restored_by ? <div className="text-xs text-muted-foreground">Restored by {r.restored_by}{r.restore_note ? `: ${r.restore_note}` : ""}</div> : null}
                {r.last_error ? <div className="text-xs text-muted-foreground">{r.last_error}</div> : null}
              </TableCell>
              <TableCell className="text-xs whitespace-normal">{grantList(r.snapshot)}</TableCell>
              <TableCell className="text-xs whitespace-normal">{grantList(r.regranted)}</TableCell>
              <TableCell className="text-xs whitespace-normal">{grantList(r.skipped)}</TableCell>
              <TableCell>{r.case_id ? <Link className="font-mono text-link hover:underline" to={paths.case(r.case_id)}>{r.case_id}</Link> : "—"}</TableCell>
              <TableCell className="text-xs">{dateTime(r.created_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {restoring && (
        <RestoreSheet
          uid={uid}
          onClose={() => setRestoring(false)}
          onDone={(p) => {
            setRestoring(false);
            toast.success("Promotional grants restored.");
            onPage(p);
          }}
        />
      )}
    </Panel>
  );
}

function RestoreSheet({ uid, onClose, onDone }: { uid: string; onClose: () => void; onDone: (p: AccountPageData) => void }) {
  const { api, withReauth } = useServices();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      onDone(await withReauth(() => api.accountAction(uid, { action: "restore_promo_grants", note: note.trim() })));
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "nothing_to_restore"
          ? "No removed promotional grants on this account."
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      kind="alert"
      title="Restore promotional grants"
      subtitle="Gives back what a lost dispute or a fraud warning took, up to each grant's original end. Expired ones are skipped."
      onClose={onClose}
      busy={busy}
      confirmLabel={busy ? "Restoring…" : "Restore"}
      onConfirm={() => void confirm()}
      confirmDisabled={!note.trim()}
    >
      <Field>
        <FieldLabel>Reason</FieldLabel>
        <FieldControl>
          <Textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </FieldControl>
        <FieldDescription>Required. Logged on the account and the dispute case.</FieldDescription>
      </Field>
      {error && <Note tone="error">{error}</Note>}
    </Modal>
  );
}
