import { useState } from "react";

import { Banner, Button, Chip, ErrorState, Field, Sheet, Spinner, StateBox } from "../components/ui";
import { ApiError, errorMessage } from "../lib/api";
import { dateOnly, dateTime, money, parseSignedDollars, words } from "../lib/format";
import { REASONS, statusLabel } from "../lib/labels";
import { Link, paths, useRouter } from "../lib/router";
import { useServices } from "../lib/services";
import type { AccountAction, AccountActionBody, AccountPage as Page } from "../lib/types";
import { useLoad } from "../lib/useLoad";

/** Accounts: look one up by Firebase UID (case pages link here directly). */
export function AccountLookup() {
  const { navigate } = useRouter();
  const [uid, setUid] = useState("");
  return (
    <>
      <div className="titlebar"><h1>Accounts</h1></div>
      <form
        className="row gap8"
        onSubmit={(e) => {
          e.preventDefault();
          if (uid.trim()) navigate(paths.account(uid.trim()));
        }}
      >
        <input
          className="input search"
          placeholder="Firebase UID"
          aria-label="Firebase UID"
          value={uid}
          onChange={(e) => setUid(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={!uid.trim()}>Open</Button>
      </form>
      <p className="muted small">
        To find an account by email, search the cases list, or look the UID up in Firebase Authentication.
      </p>
    </>
  );
}

type Sheet =
  | { kind: "action"; action: AccountAction }
  | { kind: "open_case" }
  | null;

const ACTION_COPY: Record<AccountAction, { title: string; body: string; button: string }> = {
  clear_review: { title: "Clear review", body: "The account is no longer under review.", button: "Clear review" },
  clear_sheet_only: {
    title: "Clear sheet-only",
    body: "Runs can charge saved methods again without the pay sheet.",
    button: "Clear sheet-only",
  },
  block: { title: "Add to the block list", body: "New runs are refused (403 account_blocked).", button: "Block" },
  unblock: { title: "Remove from the block list", body: "New runs are allowed again.", button: "Unblock" },
  resend_e2: { title: "Resend E2", body: "Sends the payment-failed mail again with what's owed now.", button: "Send" },
  write_off_owed: {
    title: "Write off owed",
    body: "Waives every owed run and group. For a single run, use a Waive case instead.",
    button: "Write off",
  },
  adjust_balance: { title: "Adjust balance", body: "Adds (or, negative, removes) balance. It needs a case.", button: "Adjust" },
};

/** A3: one account. */
export function AccountPage({ uid }: { uid: string }) {
  const { api } = useServices();
  const { state, retry, set } = useLoad(() => api.getAccount(uid), [api, uid]);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [flash, setFlash] = useState("");

  if (state.kind === "loading") return <div className="center pad"><Spinner label="Loading the account" /></div>;
  if (state.kind === "error") {
    if (state.error instanceof ApiError && state.error.status === 404) {
      return <StateBox title="No account with that ID." />;
    }
    return <ErrorState title="Couldn't load the account." message={errorMessage(state.error)} onRetry={retry} />;
  }
  const p = state.data;
  const a = p.account;
  const b = p.billing_state;
  const bal = p.balance;
  const cases = p.cases ?? [];
  const charges = p.charges ?? [];
  const refunds = p.refunds ?? [];
  const methods = p.methods ?? [];
  const ledger = p.ledger ?? [];

  const act = (action: AccountAction) => setSheet({ kind: "action", action });

  return (
    <>
      <Link to={paths.accounts()} className="xs muted back">← Accounts</Link>
      <div className="ch">
        <div className="row gap12 wrap">
          <h1>{a.email || a.uid}</h1>
          {a.deleted && <Chip tone="muted">Deleted</Chip>}
          {a.blocked && <Chip tone="red">Blocked</Chip>}
          {b.under_review && <Chip tone="amber">Under review</Chip>}
          {b.sheet_only && <Chip tone="amber">Sheet-only</Chip>}
          {p.owed_cents > 0 && <Chip tone="red">Owes {money(p.owed_cents)}</Chip>}
        </div>
        <div className="facts">
          <span>UID <b className="mono">{a.uid}</b></span>
          {a.stripe_customer_id && <span>Stripe <b className="mono">{a.stripe_customer_id}</b></span>}
          <span>Paid in total <b>{money(b.lifetime_paid_cents ?? 0)}</b></span>
          {p.plan && (
            <span>
              Plan <b>{p.plan.name ?? p.plan.plan}</b> · {p.plan.status}
              {p.plan.cancel_at_period_end ? " · cancels at period end" : ""}
            </span>
          )}
        </div>
      </div>

      <div className="acts">
        {b.under_review && <Button onClick={() => act("clear_review")}>Clear review</Button>}
        {b.sheet_only && <Button onClick={() => act("clear_sheet_only")}>Clear sheet-only</Button>}
        {p.owed_cents > 0 && <Button onClick={() => act("write_off_owed")}>Write off {money(p.owed_cents)}…</Button>}
        {p.owed_cents > 0 && <Button onClick={() => act("resend_e2")}>Resend E2</Button>}
        <Button onClick={() => act(a.blocked ? "unblock" : "block")}>{a.blocked ? "Remove from block list" : "Add to block list"}</Button>
        <Button onClick={() => act("adjust_balance")}>Adjust balance…</Button>
        <Button variant="primary" onClick={() => setSheet({ kind: "open_case" })}>Open a case…</Button>
      </div>
      {flash && <p className="ok small" role="status">{flash}</p>}

      <div className="grid3">
        <CompanyCard company={p.company ?? null} />
        <section className="card">
          <div className="sh"><b>Billing state</b></div>
          <dl className="kv pad">
            <dt>Flow</dt><dd>{words(b.flow_state) || "—"}</dd>
            <dt>Sheet-only</dt><dd>{b.sheet_only ? `yes${b.sheet_only_reason ? ` · ${words(b.sheet_only_reason)}` : ""}` : "no"}</dd>
            <dt>All methods failed</dt><dd>{b.all_methods_failed ? "yes" : "no"}</dd>
            <dt>Last good method</dt><dd className="mono">{b.last_good_method || "—"}</dd>
            <dt>Under review</dt><dd>{b.under_review ? "yes" : "no"}</dd>
            <dt>Owed</dt><dd>{money(p.owed_cents)}</dd>
          </dl>
        </section>
        <section className="card">
          <div className="sh"><b>Balance</b></div>
          {bal ? (
            <dl className="kv pad">
              <dt>Balance</dt><dd>{money(bal.balance_cents)}</dd>
              <dt>Held</dt><dd>{money(bal.held_cents)} · {bal.held_runs} runs</dd>
              <dt>Frozen</dt><dd>{money(bal.frozen_cents)}</dd>
              <dt>Available</dt><dd>{money(bal.available_cents)}</dd>
              <dt>Expires</dt><dd>{bal.expired ? "expired" : dateOnly(bal.expires_at)}</dd>
              <dt>Auto-reload</dt>
              <dd>
                {bal.auto_reload.enabled
                  ? `below ${money(bal.auto_reload.below_cents)} add ${money(bal.auto_reload.add_cents)}`
                  : "off"}
                {bal.auto_reload.paused_reason ? ` · paused: ${words(bal.auto_reload.paused_reason)}` : ""}
              </dd>
            </dl>
          ) : (
            <p className="muted xs pad">No balance.</p>
          )}
        </section>
        <section className="card">
          <div className="sh"><b>Saved methods</b></div>
          {methods.length === 0 ? (
            <p className="muted xs pad">None saved.</p>
          ) : (
            <ul className="plainlist pad">
              {methods.map((m, i) => (
                <li key={m.id}>
                  {m.label} <span className="muted xs">{m.type}{i === 0 ? " · default" : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card">
        <div className="sh"><b>Cases</b><span className="xs muted">{cases.length}</span></div>
        {cases.length === 0 ? (
          <p className="muted xs pad">No cases.</p>
        ) : (
          <table className="at">
            <thead><tr><th>Case</th><th>Type · reason</th><th>Status</th><th className="num">Requested</th><th className="num">Decided</th><th>Opened</th></tr></thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td><Link className="cid mono" to={paths.case(c.id)}>{c.id}</Link></td>
                  <td>{words(c.type)} · <span className="muted">{words(c.reason)}</span></td>
                  <td>{statusLabel(c.status, c.result)}</td>
                  <td className="num">{money(c.requested_cents)}</td>
                  <td className="num">{money(c.decided_cents)}</td>
                  <td>{dateOnly(c.opened_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="sh"><b>Payment history</b><span className="xs muted">{charges.length} charges · {refunds.length} refunds</span></div>
        {charges.length === 0 ? (
          <p className="muted xs pad">No charges.</p>
        ) : (
          <table className="at">
            <thead><tr><th>Date</th><th>Kind</th><th>Runs</th><th className="num">Amount</th><th>Invoice</th></tr></thead>
            <tbody>
              {charges.map((ch) => (
                <tr key={ch.charge_id}>
                  <td>{dateTime(ch.paid_at)}</td>
                  <td>{words(ch.kind)}</td>
                  <td className="wrap">
                    {(ch.lines ?? []).map((l) => (
                      <div key={l.conversion_id} className="xs">
                        <span className="mono muted">{l.conversion_id}</span> {l.description} · {money(l.amount_cents)}
                      </div>
                    ))}
                  </td>
                  <td className="num">{money(ch.amount_cents)}</td>
                  <td>{words(ch.invoice_state) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {refunds.length > 0 && (
          <table className="at">
            <thead><tr><th>Refund</th><th>Case</th><th className="num">Amount</th><th>Status</th><th>Source</th><th>Date</th></tr></thead>
            <tbody>
              {refunds.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.re_id || r.id}</td>
                  <td><Link className="link mono" to={paths.case(r.case_id)}>{r.case_id}</Link></td>
                  <td className="num">{money(r.total_cents)}</td>
                  <td>{words(r.status)}{r.fail_reason ? ` · ${r.fail_reason}` : ""}</td>
                  <td>{r.source}</td>
                  <td>{dateOnly(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="sh"><b>Balance ledger</b><span className="xs muted">latest 50</span></div>
        {ledger.length === 0 ? (
          <p className="muted xs pad">No entries.</p>
        ) : (
          <table className="at">
            <thead><tr><th>When</th><th>Kind</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td>{dateTime(e.at)}</td>
                  <td>{words(e.kind)}</td>
                  <td className="num">{money(e.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {sheet?.kind === "action" && (
        <AccountActionSheet
          page={p}
          action={sheet.action}
          onClose={() => setSheet(null)}
          onDone={(next) => {
            set(next);
            setSheet(null);
            setFlash("Done.");
          }}
        />
      )}
      {sheet?.kind === "open_case" && <OpenCaseSheet uid={a.uid} onClose={() => setSheet(null)} />}
    </>
  );
}

function AccountActionSheet({
  page,
  action,
  onClose,
  onDone,
}: {
  page: Page;
  action: AccountAction;
  onClose: () => void;
  onDone: (p: Page) => void;
}) {
  const { api, withReauth } = useServices();
  const [amount, setAmount] = useState("");
  const [caseId, setCaseId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copy = ACTION_COPY[action];
  const cents = parseSignedDollars(amount);
  const isAdjust = action === "adjust_balance";
  const blocked = isAdjust && (!cents || !caseId.trim() || !note.trim());

  const confirm = async () => {
    setBusy(true);
    setError("");
    const body: AccountActionBody = { action };
    if (isAdjust) Object.assign(body, { cents: cents ?? 0, case_id: caseId.trim(), note: note.trim() });
    try {
      onDone(await withReauth(() => api.accountAction(page.account.uid, body)));
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg.startsWith("That didn't work") || msg.startsWith("Not confirmed") ? msg : `That didn't work: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const title =
    action === "write_off_owed" ? `Write off ${money(page.owed_cents)}` : isAdjust && cents ? `Adjust balance by ${money(cents)}` : copy.title;

  return (
    <Sheet
      title={title}
      subtitle={page.account.email || page.account.uid}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="lg" onClick={() => void confirm()} disabled={busy || blocked}>
            {busy ? "Working…" : copy.button}
          </Button>
        </>
      }
    >
      <p className="small">{copy.body}</p>
      {isAdjust && (
        <>
          <Field label="Amount (negative removes)" hint={page.balance ? `Balance now ${money(page.balance.balance_cents)}` : undefined}>
            <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Case">
            <input className="input mono" placeholder="CASE-0042" value={caseId} onChange={(e) => setCaseId(e.target.value)} />
          </Field>
          <Field label="Reason">
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </>
      )}
      {error && <p className="err small" role="alert">{error}</p>}
    </Sheet>
  );
}

const OPEN_REASONS = REASONS.filter(
  (r) => !["dispute", "efw", "refund_failed", "dashboard_unassigned", "late_or_duplicate"].includes(r),
);

function OpenCaseSheet({ uid, onClose }: { uid: string; onClose: () => void }) {
  const { api } = useServices();
  const { navigate } = useRouter();
  const [reason, setReason] = useState("support_request");
  const [ids, setIds] = useState("");
  const [topup, setTopup] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const balanceReason = reason === "topup_withdrawal" || reason === "closure_balance";
  const conversionIds = ids.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const blocked = balanceReason ? reason === "topup_withdrawal" && !topup.trim() : conversionIds.length === 0;

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.openCase({
        uid,
        reason,
        text: text.trim() || undefined,
        conversion_ids: balanceReason ? undefined : conversionIds,
        topup_id: balanceReason ? topup.trim() || undefined : undefined,
      });
      const first = res.cases?.[0]?.case.id;
      if (first) navigate(paths.case(first));
      else onClose();
    } catch (err) {
      setError(`That didn't work: ${errorMessage(err)}`);
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Open a case"
      subtitle="The policy classifies it: auto reasons refund at once, the rest wait for you."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="lg" onClick={() => void submit()} disabled={busy || blocked}>
            {busy ? "Working…" : "Open case"}
          </Button>
        </>
      }
    >
      <Field label="Reason">
        <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
          {OPEN_REASONS.map((r) => <option key={r} value={r}>{words(r)}</option>)}
        </select>
      </Field>
      {balanceReason ? (
        <Field label="Top-up ID" hint={reason === "closure_balance" ? "Optional for a closure." : undefined}>
          <input className="input mono" value={topup} onChange={(e) => setTopup(e.target.value)} />
        </Field>
      ) : (
        <Field label="Runs (conversion IDs)" hint="Separated by spaces or commas.">
          <input className="input mono" value={ids} onChange={(e) => setIds(e.target.value)} />
        </Field>
      )}
      <Field label="What the customer asked (plain text)">
        <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      {reason === "support_request" && (
        <Banner tone="blue">A delivered run opens a manual case; an unfinished or failed one may refund at once.</Banner>
      )}
      {error && <p className="err small" role="alert">{error}</p>}
    </Sheet>
  );
}

/** The business details on the account's invoices (owner 2026-11-04). */
function CompanyCard({ company: c }: { company: Page["company"] }) {
  if (!c || !(c.company_name || c.tax_id || c.address || c.billing_email || c.po_reference)) return null;
  const addr = c.address
    ? [c.address.line1, c.address.line2, [c.address.postal_code, c.address.city].filter(Boolean).join(" "), c.address.state, c.address.country]
        .filter(Boolean)
        .join(", ")
    : "";
  return (
    <section className="card" data-testid="account-company">
      <div className="sh"><b>Business details</b><span className="xs muted">on invoices</span></div>
      <dl className="kv pad">
        <dt>Company</dt><dd>{c.company_name || "—"}</dd>
        <dt>Address</dt><dd>{addr || "—"}</dd>
        <dt>Tax ID</dt>
        <dd className="mono">
          {c.tax_id ? `${c.tax_id.type} ${c.tax_id.value}${c.tax_id.verification ? ` · ${c.tax_id.verification}` : ""}` : "—"}
        </dd>
        <dt>Billing email</dt><dd>{c.billing_email || "—"}</dd>
        <dt>PO reference</dt><dd>{c.po_reference || "—"}</dd>
      </dl>
    </section>
  );
}
