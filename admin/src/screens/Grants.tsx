import { useState } from "react";

import { Button, Chip, Field, Sheet } from "../components/ui";
import type { Tone } from "../components/ui";
import { ApiError, errorMessage } from "../lib/api";
import { dateOnly, dateTime, words } from "../lib/format";
import { useServices } from "../lib/services";
import type { Grant, GrantBody, GrantStatus } from "../lib/types";

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
  const [flash, setFlash] = useState("");

  const upsert = (g: Grant) =>
    setGrants((list) => [g, ...list.filter((x) => x.id !== g.id)].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));

  return (
    <section className="card" data-testid="grants">
      <div className="sh">
        <b>Grants</b>
        <span className="xs muted">Pro, Business or Studio given by us</span>
        <span className="grow" />
        <Button variant="primary" onClick={() => setGranting(true)}>Grant Pro…</Button>
      </div>
      {flash && <p className="ok small pad" role="status">{flash}</p>}
      {grants.length === 0 ? (
        <p className="muted xs pad">No grants.</p>
      ) : (
        <table className="at" data-testid="grants-table">
          <thead>
            <tr>
              <th>Entitlement</th>
              <th>Ends</th>
              <th>Status</th>
              <th>By</th>
              <th>Reason</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => {
              const st = STATUS[g.status] ?? { label: label(g.status), tone: "plain" as Tone };
              return (
                <tr key={g.id} data-testid={`grant-${g.id}`}>
                  <td>{label(g.entitlement)}</td>
                  <td>{dateOnly(g.ends_at)}</td>
                  <td>
                    <Chip tone={st.tone}>{st.label}</Chip>
                    {g.status === "failed" && g.rc_error ? <div className="xs muted">{g.rc_error}</div> : null}
                    {g.status === "revoked" && g.revoke_reason ? (
                      <div className="xs muted">
                        {g.revoked_by ? `${g.revoked_by}: ` : ""}
                        {g.revoke_reason}
                      </div>
                    ) : null}
                  </td>
                  <td className="xs">{g.granted_by}</td>
                  <td className="xs wrap">{g.reason}</td>
                  <td className="xs">{dateTime(g.created_at)}</td>
                  <td>
                    {g.status === "active" || g.status === "granting" ? (
                      <Button onClick={() => setRevoking(g)}>Revoke…</Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {granting && (
        <GrantSheet
          uid={uid}
          onClose={() => setGranting(false)}
          onResult={(g, message) => {
            upsert(g);
            setGranting(false);
            setFlash(message);
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
            setFlash(partial ? "Revoked. Some grants will be retried tonight." : "Revoked.");
          }}
        />
      )}
    </section>
  );
}

function GrantSheet({
  uid,
  onClose,
  onResult,
}: {
  uid: string;
  onClose: () => void;
  onResult: (g: Grant, message: string) => void;
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
      onResult(g, `${label(entitlement)} granted until ${dateOnly(g.ends_at)}.`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "grant_failed") {
        // the record stays, as failed, with the gateway's message
        const g = err.details?.grant as Grant | undefined;
        if (g) {
          onResult(g, `Not granted: ${err.message}`);
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
    <Sheet
      title="Grant Pro"
      subtitle={uid}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="lg" disabled={!ready || busy} onClick={confirm}>
            {busy ? "Granting…" : `Grant ${label(entitlement)}`}
          </Button>
        </>
      }
    >
      <Field label="Entitlement">
        <select
          className="input"
          value={entitlement}
          onChange={(e) => setEntitlement(e.target.value as GrantBody["entitlement"])}
        >
          {ENTITLEMENTS.map((e) => (
            <option key={e.id} value={e.id}>{e.label}</option>
          ))}
        </select>
      </Field>
      <fieldset className="radios" aria-label="Ends">
        <span className="field-label">Ends</span>
        {PRESETS.map((p) => (
          <label key={p.id} className="radio">
            <input type="radio" name="ends" value={p.id} checked={preset === p.id} onChange={() => setPreset(p.id)} />
            {p.label}
          </label>
        ))}
      </fieldset>
      {preset === "custom" ? (
        <Field label="End date" hint="1 hour to 5 years from now">
          <input className="input" type="date" value={custom} onChange={(e) => setCustom(e.target.value)} />
        </Field>
      ) : null}
      {end && endOk ? (
        <span className="field-hint" data-testid="grant-ends">Ends {dateOnly(end.toISOString())}</span>
      ) : preset === "custom" && custom ? (
        <span className="err small">Pick a date from 1 hour to 5 years ahead.</span>
      ) : null}
      <Field label="Reason" hint="Required. Up to 500 characters.">
        <textarea className="input" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && <p className="err small" role="alert">{error}</p>}
    </Sheet>
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
    <Sheet
      title={`Revoke ${label(grant.entitlement)}`}
      subtitle={`Granted until ${dateOnly(grant.ends_at)} by ${grant.granted_by}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="lg" disabled={!reason.trim() || busy} onClick={confirm}>
            {busy ? "Revoking…" : "Revoke"}
          </Button>
        </>
      }
    >
      <p className="small">The account loses this entitlement now. Other grants and purchases stay.</p>
      <Field label="Reason" hint="Required.">
        <textarea className="input" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && <p className="err small" role="alert">{error}</p>}
    </Sheet>
  );
}

/** Promo entitlements the gateway grants again (read only). */
export function PromoRegrants({ rows }: { rows: { id: string; status: string; entitlement?: string; ends_at?: string; created_at?: string; reason?: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="card" data-testid="promo-regrants">
      <div className="sh"><b>Promo regrants</b></div>
      <table className="at">
        <thead><tr><th>Entitlement</th><th>Status</th><th>Ends</th><th>Created</th><th>Reason</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.entitlement ? label(r.entitlement) : "—"}</td>
              <td>{label(r.status)}</td>
              <td>{r.ends_at ? dateOnly(r.ends_at) : "—"}</td>
              <td className="xs">{r.created_at ? dateTime(r.created_at) : "—"}</td>
              <td className="xs">{r.reason ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
