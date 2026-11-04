import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Banner, EmptyRow, ErrorState, FilterSelect, KV, LoadingBlock, Modal, Note, PageHeader, Panel, StateBox } from "@/components/common";
import { PasskeyNote } from "@/components/PasskeyNote";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldControl, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, errorMessage } from "../lib/api";
import { dateOnly, dateTime, money, parseSignedDollars, words } from "../lib/format";
import { REASONS, statusLabel } from "../lib/labels";
import { Link, paths, useRouter } from "../lib/router";
import { useServices } from "../lib/services";
import type { AccountAction, AccountActionBody, AccountPage as Page } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { GrantsSection, PromoRegrants } from "./Grants";

/** Accounts: look one up by Firebase UID (case pages link here directly). */
export function AccountLookup() {
  const { navigate } = useRouter();
  const [uid, setUid] = useState("");
  return (
    <>
      <PageHeader title="Accounts" />
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (uid.trim()) navigate(paths.account(uid.trim()));
        }}
      >
        <Input
          className="w-70 max-[1000px]:w-full"
          placeholder="Firebase UID"
          aria-label="Firebase UID"
          value={uid}
          onChange={(e) => setUid(e.target.value)}
        />
        <Button type="submit" variant="default" disabled={!uid.trim()}>Open</Button>
      </form>
      <p className="text-sm text-muted-foreground">
        To find an account by email, search the cases list, or look the UID up in Firebase Authentication.
      </p>
    </>
  );
}

type SheetState =
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
  // run from the Re-grants card (RestoreSheet in Grants.tsx), not this sheet
  restore_promo_grants: { title: "Restore promotional grants", body: "", button: "Restore" },
};

/** A3: one account. */
export function AccountPage({ uid }: { uid: string }) {
  const { api } = useServices();
  const { state, retry, set } = useLoad(() => api.getAccount(uid), [api, uid]);
  const [sheet, setSheet] = useState<SheetState>(null);

  if (state.kind === "loading") return <LoadingBlock label="Loading the account" />;
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
      <Link to={paths.accounts()} className="w-fit text-xs text-muted-foreground hover:text-foreground">← Accounts</Link>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{a.email || a.uid}</h1>
          {a.deleted && <Badge variant="muted">Deleted</Badge>}
          {a.blocked && <Badge variant="red">Blocked</Badge>}
          {b.under_review && <Badge variant="amber">Under review</Badge>}
          {b.sheet_only && <Badge variant="amber">Sheet-only</Badge>}
          {p.owed_cents > 0 && <Badge variant="red">Owes {money(p.owed_cents)}</Badge>}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
          <span>UID <B mono>{a.uid}</B></span>
          {a.stripe_customer_id && <span>Stripe <B mono>{a.stripe_customer_id}</B></span>}
          <span>Paid in total <B>{money(b.lifetime_paid_cents ?? 0)}</B></span>
          {p.plan && (
            <span>
              Plan <B>{p.plan.name ?? p.plan.plan}</B> · {p.plan.status}
              {p.plan.cancel_at_period_end ? " · cancels at period end" : ""}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Account actions">
        {b.under_review && <Button onClick={() => act("clear_review")}>Clear review</Button>}
        {b.sheet_only && <Button onClick={() => act("clear_sheet_only")}>Clear sheet-only</Button>}
        {p.owed_cents > 0 && <Button onClick={() => act("write_off_owed")}>Write off {money(p.owed_cents)}…</Button>}
        {p.owed_cents > 0 && <Button onClick={() => act("resend_e2")}>Resend E2</Button>}
        <Button onClick={() => act(a.blocked ? "unblock" : "block")}>{a.blocked ? "Remove from block list" : "Add to block list"}</Button>
        <Button onClick={() => act("adjust_balance")}>Adjust balance…</Button>
        <Button variant="default" onClick={() => setSheet({ kind: "open_case" })}>Open a case…</Button>
      </div>

      <div className="grid grid-cols-3 items-start gap-4 max-[1000px]:grid-cols-1">
        <CompanyCard company={p.company ?? null} changes={p.company_changes ?? []} />
        <Panel title="Billing state">
          <KV>
            <dt>Flow</dt><dd>{words(b.flow_state) || "—"}</dd>
            <dt>Sheet-only</dt><dd>{b.sheet_only ? `yes${b.sheet_only_reason ? ` · ${words(b.sheet_only_reason)}` : ""}` : "no"}</dd>
            <dt>All methods failed</dt><dd>{b.all_methods_failed ? "yes" : "no"}</dd>
            <dt>Last good method</dt><dd className="font-mono">{b.last_good_method || "—"}</dd>
            <dt>Under review</dt><dd>{b.under_review ? "yes" : "no"}</dd>
            <dt>Owed</dt><dd className="tabular-nums">{money(p.owed_cents)}</dd>
          </KV>
        </Panel>
        <Panel title="Balance">
          {bal ? (
            <KV>
              <dt>Balance</dt><dd className="tabular-nums">{money(bal.balance_cents)}</dd>
              <dt>Held</dt><dd className="tabular-nums">{money(bal.held_cents)} · {bal.held_runs} runs</dd>
              <dt>Frozen</dt><dd className="tabular-nums">{money(bal.frozen_cents)}</dd>
              <dt>Available</dt><dd className="tabular-nums">{money(bal.available_cents)}</dd>
              <dt>Expires</dt><dd>{bal.expired ? "expired" : dateOnly(bal.expires_at)}</dd>
              <dt>Auto-reload</dt>
              <dd className="tabular-nums">
                {bal.auto_reload.enabled
                  ? `below ${money(bal.auto_reload.below_cents)} add ${money(bal.auto_reload.add_cents)}`
                  : "off"}
                {bal.auto_reload.paused_reason ? ` · paused: ${words(bal.auto_reload.paused_reason)}` : ""}
              </dd>
            </KV>
          ) : (
            <EmptyRow>No balance.</EmptyRow>
          )}
        </Panel>
        <Panel title="Saved methods">
          {methods.length === 0 ? (
            <EmptyRow>None saved.</EmptyRow>
          ) : (
            <ul className="flex list-none flex-col gap-1.5 px-4 py-3">
              {methods.map((m, i) => (
                <li key={m.id}>
                  {m.label} <span className="text-xs text-muted-foreground">{m.type}{i === 0 ? " · default" : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Cases" note={<span className="tabular-nums">{cases.length}</span>}>
        {cases.length === 0 ? (
          <EmptyRow>No cases.</EmptyRow>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead><TableHead>Type · reason</TableHead><TableHead>Status</TableHead>
                <TableHead numeric>Requested</TableHead><TableHead numeric>Decided</TableHead><TableHead>Opened</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cases.map((c) => (
                <TableRow key={c.id}>
                  <TableCell><Link className="font-mono font-medium text-link" to={paths.case(c.id)}>{c.id}</Link></TableCell>
                  <TableCell>{words(c.type)} · <span className="text-muted-foreground">{words(c.reason)}</span></TableCell>
                  <TableCell>{statusLabel(c.status, c.result)}</TableCell>
                  <TableCell numeric>{money(c.requested_cents)}</TableCell>
                  <TableCell numeric>{money(c.decided_cents)}</TableCell>
                  <TableCell>{dateOnly(c.opened_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      <Panel title="Payment history" note={`${charges.length} charges · ${refunds.length} refunds`}>
        {charges.length === 0 ? (
          <EmptyRow>No charges.</EmptyRow>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead><TableHead>Kind</TableHead><TableHead>Runs</TableHead><TableHead numeric>Amount</TableHead><TableHead>Invoice</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {charges.map((ch) => (
                <TableRow key={ch.charge_id}>
                  <TableCell>{dateTime(ch.paid_at)}</TableCell>
                  <TableCell>{words(ch.kind)}</TableCell>
                  <TableCell className="whitespace-normal">
                    {(ch.lines ?? []).map((l) => (
                      <div key={l.conversion_id} className="text-xs">
                        <span className="font-mono text-muted-foreground">{l.conversion_id}</span> {l.description} ·{" "}
                        <span className="tabular-nums">{money(l.amount_cents)}</span>
                      </div>
                    ))}
                  </TableCell>
                  <TableCell numeric>{money(ch.amount_cents)}</TableCell>
                  <TableCell>{words(ch.invoice_state) || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {refunds.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Refund</TableHead><TableHead>Case</TableHead><TableHead numeric>Amount</TableHead><TableHead>Status</TableHead><TableHead>Source</TableHead><TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {refunds.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono">{r.re_id || r.id}</TableCell>
                  <TableCell><Link className="font-mono text-link hover:underline" to={paths.case(r.case_id)}>{r.case_id}</Link></TableCell>
                  <TableCell numeric>{money(r.total_cents)}</TableCell>
                  <TableCell>{words(r.status)}{r.fail_reason ? ` · ${r.fail_reason}` : ""}</TableCell>
                  <TableCell>{r.source}</TableCell>
                  <TableCell>{dateOnly(r.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      <GrantsSection uid={a.uid} initial={p.grants ?? []} />
      <PromoRegrants uid={a.uid} rows={p.promo_regrants ?? []} onPage={set} />

      <Panel title="Balance ledger" note="latest 50">
        {ledger.length === 0 ? (
          <EmptyRow>No entries.</EmptyRow>
        ) : (
          <Table>
            <TableHeader>
              <TableRow><TableHead>When</TableHead><TableHead>Kind</TableHead><TableHead numeric>Amount</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {ledger.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{dateTime(e.at)}</TableCell>
                  <TableCell>{words(e.kind)}</TableCell>
                  <TableCell numeric>{money(e.cents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      {sheet?.kind === "action" && (
        <AccountActionSheet
          page={p}
          action={sheet.action}
          onClose={() => setSheet(null)}
          onDone={(next) => {
            set(next);
            setSheet(null);
            toast.success("Done.");
          }}
        />
      )}
      {sheet?.kind === "open_case" && <OpenCaseSheet uid={a.uid} onClose={() => setSheet(null)} />}
    </>
  );
}

function B({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return <b className={mono ? "font-mono font-medium text-foreground" : "font-medium text-foreground tabular-nums"}>{children}</b>;
}


/** Money and blocking: an AlertDialog. */
const ALERT_ACTIONS: AccountAction[] = ["write_off_owed", "adjust_balance", "block"];

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
    <Modal
      kind={ALERT_ACTIONS.includes(action) ? "alert" : "dialog"}
      title={title}
      subtitle={page.account.email || page.account.uid}
      onClose={onClose}
      busy={busy}
      confirmLabel={busy ? "Working…" : copy.button}
      onConfirm={() => void confirm()}
      confirmDisabled={blocked}
    >
      <p className="text-sm">{copy.body}</p>
      {isAdjust && (
        <>
          <Field>
            <FieldLabel>Amount (negative removes)</FieldLabel>
            <FieldControl>
              <Input className="w-32 text-right font-mono tabular-nums" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FieldControl>
            {page.balance && <FieldDescription>Balance now {money(page.balance.balance_cents)}</FieldDescription>}
          </Field>
          <Field>
            <FieldLabel>Case</FieldLabel>
            <FieldControl>
              <Input className="font-mono" placeholder="CASE-0042" value={caseId} onChange={(e) => setCaseId(e.target.value)} />
            </FieldControl>
          </Field>
          <Field>
            <FieldLabel>Reason</FieldLabel>
            <FieldControl>
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </FieldControl>
          </Field>
        </>
      )}
      {(action === "write_off_owed" || isAdjust) && <PasskeyNote />}
      {error && <Note tone="error">{error}</Note>}
    </Modal>
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
    <Modal
      kind="sheet"
      title="Open a case"
      subtitle="The policy classifies it: auto reasons refund at once, the rest wait for you."
      onClose={onClose}
      busy={busy}
      confirmLabel={busy ? "Working…" : "Open case"}
      onConfirm={() => void submit()}
      confirmDisabled={blocked}
    >
      <Field>
        <FieldLabel>Reason</FieldLabel>
        <FieldControl>
          <FilterSelect
            label="Reason"
            size="default"
            className="w-full"
            value={reason}
            onChange={setReason}
            options={OPEN_REASONS.map((r) => ({ value: r, label: words(r) }))}
          />
        </FieldControl>
      </Field>
      {balanceReason ? (
        <Field>
          <FieldLabel>Top-up ID</FieldLabel>
          <FieldControl>
            <Input className="font-mono" value={topup} onChange={(e) => setTopup(e.target.value)} />
          </FieldControl>
          {reason === "closure_balance" && <FieldDescription>Optional for a closure.</FieldDescription>}
        </Field>
      ) : (
        <Field>
          <FieldLabel>Runs (conversion IDs)</FieldLabel>
          <FieldControl>
            <Input className="font-mono" value={ids} onChange={(e) => setIds(e.target.value)} />
          </FieldControl>
          <FieldDescription>Separated by spaces or commas.</FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel>What the customer asked (plain text)</FieldLabel>
        <FieldControl>
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </FieldControl>
      </Field>
      {reason === "support_request" && (
        <Banner tone="blue">A delivered run opens a manual case; an unfinished or failed one may refund at once.</Banner>
      )}
      {error && <Note tone="error">{error}</Note>}
    </Modal>
  );
}

/** The business details on the account's invoices (owner 2026-11-04). */
function CompanyCard({ company: c, changes }: { company: Page["company"]; changes: NonNullable<Page["company_changes"]> }) {
  if (!c || !(c.company_name || c.tax_id || c.address || c.billing_email || c.po_reference)) return null;
  const addr = c.address
    ? [c.address.line1, c.address.line2, [c.address.postal_code, c.address.city].filter(Boolean).join(" "), c.address.state, c.address.country]
        .filter(Boolean)
        .join(", ")
    : "";
  return (
    <Panel title="Business details" note="on invoices" data-testid="account-company">
      <KV>
        <dt>Company</dt><dd>{c.company_name || "—"}</dd>
        <dt>Address</dt><dd>{addr || "—"}</dd>
        <dt>Tax ID</dt>
        <dd className="font-mono">
          {c.tax_id ? `${c.tax_id.type} ${c.tax_id.value}${c.tax_id.verification ? ` · ${c.tax_id.verification}` : ""}` : "—"}
        </dd>
        <dt>Billing email</dt><dd>{c.billing_email || "—"}</dd>
        <dt>PO reference</dt><dd>{c.po_reference || "—"}</dd>
      </KV>
      {changes.length > 0 && (
        <div className="px-4 pb-3" data-testid="company-changes">
          <div className="text-xs text-muted-foreground">Changes</div>
          <ul className="text-xs">
            {[...changes].reverse().map((ch, i) => (
              <li key={ch.at + i}>
                {dateTime(ch.at)} · {ch.by === "checkout" ? "at checkout" : ch.by === "user" ? "by the customer" : ch.by} ·{" "}
                {(ch.fields ?? []).map(words).join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
