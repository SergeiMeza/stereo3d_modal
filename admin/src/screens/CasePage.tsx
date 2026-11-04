import { useEffect, useState } from "react";

import { Banner, Button, Chip, ErrorState, PlainText, Spinner, StateBox } from "../components/ui";
import { ApiError, errorMessage } from "../lib/api";
import { dateOnly, dateTime, money, until, words } from "../lib/format";
import { statusLabel, statusTone, typeLabel, typeTone } from "../lib/labels";
import { Link, paths } from "../lib/router";
import { useServices } from "../lib/services";
import type { CaseAction, CasePage as Page, MailPreviewsResponse } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { ActionSheet, approveItems, isBalanceCase, owedTotal } from "./ActionSheet";
import { deliveredChip, EvidencePanel } from "./CaseEvidence";

/** A2: one case. */
export function CasePage({ id }: { id: string }) {
  const { api } = useServices();
  const { state, retry, reload, set } = useLoad(() => api.getCase(id), [api, id]);
  const [previews, setPreviews] = useState<MailPreviewsResponse | null>(null);

  useEffect(() => {
    api.mailPreviews().then(setPreviews).catch(() => setPreviews(null));
  }, [api]);

  return (
    <>
      <Link to={paths.cases()} className="xs muted back">← Cases</Link>
      {state.kind === "loading" && (
        <div className="center pad"><Spinner label="Loading the case" /></div>
      )}
      {state.kind === "error" &&
        (state.error instanceof ApiError && state.error.status === 404 ? (
          <StateBox title={`No case ${id}.`} />
        ) : (
          <ErrorState title="Couldn't load the case." message={errorMessage(state.error)} onRetry={retry} />
        ))}
      {state.kind === "loaded" && (
        <CaseBody page={state.data} previews={previews} onPage={set} onReload={reload} />
      )}
    </>
  );
}

const LABELS: Partial<Record<CaseAction, string>> = {
  partial: "Partial…",
  deny: "Deny…",
  no_refund: "No refund",
  ask: "Ask the customer…",
  customer_reply: "Customer replied…",
  mark_out_of_band: "Mark refunded outside Stripe…",
  assign: "Assign refund…",
  stop_run: "Stop run now",
  accept_dispute: "Accept",
  counter_dispute: "Counter",
  counter_with_refund_proof: "Counter with refund proof",
};

function CaseBody({
  page,
  previews,
  onPage,
  onReload,
}: {
  page: Page;
  previews: MailPreviewsResponse | null;
  onPage: (p: Page) => void;
  onReload: () => Promise<Page>;
}) {
  const { api } = useServices();
  const [sheet, setSheet] = useState<CaseAction | null>(null);
  const [flash, setFlash] = useState("");
  const [inlineErr, setInlineErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const c = page.case;
  const actions = page.actions ?? [];
  const has = (a: CaseAction) => actions.includes(a);
  const runs = page.runs ?? [];
  const evRuns = page.evidence?.runs ?? [];
  const max = page.max_refundable_cents;
  const waive = c.type === "waive";
  const banners = page.banners ?? [];
  const hints = page.hints ?? [];
  const refunded = (page.refunds ?? []).some((r) => ["pending", "succeeded", "out_of_band"].includes(r.status));
  const pm = page.account.payment_method ?? "";
  const windowed = /alipay|wechat/i.test(pm);
  const downloadsByRun = (() => {
    const d = page.evidence?.downloads;
    if (!Array.isArray(d)) return null;
    const m: Record<string, number> = {};
    for (const x of d) if (x.conversion_id) m[x.conversion_id] = (m[x.conversion_id] ?? 0) + 1;
    return m;
  })();

  // A customer message on a closed case opens a new linked case (gateway
  // 00107): the new one names follow_up_of, the closed one lists it.
  const followUpOf = c.follow_up_of || c.related.follow_up_of || "";
  const followUps = [
    ...new Set([
      ...(c.follow_up_ids ?? []),
      ...(c.related.follow_up_ids ?? []),
      ...(page.related_cases ?? []).filter((r) => r.follow_up_of === c.id).map((r) => r.id),
    ]),
  ].filter((id) => id && id !== followUpOf);

  const done = (next: Page) => {
    onPage(next);
    setSheet(null);
    setFlash("Done.");
  };

  const refresh = async () => {
    setRefreshing(true);
    setInlineErr("");
    try {
      onPage(await api.caseAction(c.id, { action: "refresh_evidence" }));
    } catch (err) {
      setInlineErr(`That didn't work: ${errorMessage(err)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const primary: CaseAction[] = [];
  if (has("approve")) primary.push("approve");
  if (has("waive")) primary.push("waive");
  if (has("counter_with_refund_proof") && refunded) primary.push("counter_with_refund_proof");
  const secondary = actions.filter(
    (a) => !primary.includes(a) && !["note", "refresh_evidence", "close", "approve", "waive"].includes(a),
  );
  const approveDisabled = max <= 0 || Object.keys(approveItems(page)).length === 0 && !isBalanceCase(page);

  return (
    <>
      <div className="ch">
        <div className="row gap12 wrap">
          <h1 className="mono">{c.id}</h1>
          <Chip tone={typeTone(c.type)}>{typeLabel(c.type)}</Chip>
          <span className="muted">{words(c.reason)} · {c.mode}</span>
          <Chip tone={statusTone(c.status, c.result)}>{statusLabel(c.status, c.result)}</Chip>
          {c.deadline_at && c.open && (
            <span className={`due right ${new Date(c.deadline_at).getTime() - Date.now() < 12 * 3600e3 ? "red" : ""}`}>
              Due {dateTime(c.deadline_at)} · {until(c.deadline_at)}
            </span>
          )}
        </div>
        <div className="facts">
          <span>
            Account{" "}
            {c.uid ? (
              <Link className="link" to={paths.account(c.uid)}>{page.account.email || c.uid}</Link>
            ) : (
              <span className="muted">none</span>
            )}
          </span>
          {pm && <span>Method <b>{pm}</b></span>}
          <span>Opened {dateTime(c.opened_at)} by {c.source}</span>
          <span>{c.customer_visible ? "Customer-visible" : "Not customer-visible"}</span>
          {c.decision && (
            <span>
              Decision <b>{words(c.decision.kind)}</b> by {c.decision.by} · {dateTime(c.decision.at)}
            </span>
          )}
        </div>
      </div>

      {windowed && c.open && c.deadline_at && (
        <Banner tone="amber">
          Refund window closes {until(c.deadline_at)}: {pm} refunds are only possible for a limited time.
        </Banner>
      )}
      {banners.map((b, i) => (
        <Banner
          key={i}
          tone={/failed/i.test(b) ? "red" : /superseded/i.test(b) ? "amber" : "blue"}
          action={
            c.status === "waiting_for_run" && has("stop_run") && /waiting for the run/i.test(b) ? (
              <Button size="sm" onClick={() => setSheet("stop_run")}>Stop run now</Button>
            ) : /failed/i.test(b) && has("mark_out_of_band") ? (
              <Button size="sm" onClick={() => setSheet("mark_out_of_band")}>Mark refunded outside Stripe…</Button>
            ) : undefined
          }
        >
          <PlainText text={b} className="inline" />
        </Banner>
      ))}
      {c.related.superseded_by && (
        <p className="small">
          Superseded by <Link className="link mono" to={paths.case(c.related.superseded_by)}>{c.related.superseded_by}</Link>
        </p>
      )}
      {followUpOf && (
        <p className="small" data-testid="follow-up-of">
          Follow-up of <Link className="link mono" to={paths.case(followUpOf)}>{followUpOf}</Link>
        </p>
      )}
      {followUps.length > 0 && (
        <p className="small" data-testid="follow-ups">
          Follow-up{followUps.length > 1 ? "s" : ""}:{" "}
          {followUps.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <Link className="link mono" to={paths.case(id)}>{id}</Link>
            </span>
          ))}
        </p>
      )}
      {c.related.duplicate_of && (
        <p className="small">
          Duplicate of <Link className="link mono" to={paths.case(c.related.duplicate_of)}>{c.related.duplicate_of}</Link>
        </p>
      )}

      {c.dispute && (
        <div className="card pad facts">
          <span>Dispute <b className="mono">{c.dispute.id}</b></span>
          <span>Amount <b>{money(c.dispute.amount_cents)}</b></span>
          <span>Reason <b>{words(c.dispute.reason)}</b></span>
          <span>Status <b>{words(c.dispute.status)}</b></span>
          {c.dispute.due_by && <span>Evidence due <b>{dateTime(c.dispute.due_by)}</b> · {until(c.dispute.due_by)}</span>}
          {c.dispute.outcome && <span>Outcome <b>{c.dispute.outcome}</b></span>}
        </div>
      )}

      {runs.length > 0 && (
        <div className="card scroll-x">
          <table className="at runs">
            <thead>
              <tr>
                <th>Run</th>
                <th className="num">Price</th>
                {waive ? <th className="num">Owed</th> : <th className="num">Refunded so far</th>}
                {!waive && <th className="num">Refundable now</th>}
                <th>Paid from</th>
                <th>Delivered</th>
                <th className="num">Downloads</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.conversion_id}>
                  <td>
                    <span className="mono xs muted">{r.conversion_id}</span> {r.label}
                  </td>
                  <td className="num">{money(r.price_cents)}</td>
                  {waive ? (
                    <td className="num"><b>{money(r.owed_cents ?? 0)}</b></td>
                  ) : (
                    <td className="num">{money(r.refunded_cents ?? 0)}</td>
                  )}
                  {!waive && <td className="num"><b>{money(r.refundable_cents)}</b></td>}
                  <td>{words(r.paid_from)}</td>
                  <td>{deliveredChip(r.delivered, evRuns.find((e) => e.conversion_id === r.conversion_id))}</td>
                  <td className="num">{downloadsByRun ? downloadsByRun[r.conversion_id] ?? 0 : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.length === 0 && isBalanceCase(page) && (
        <p className="small">Balance refund · refundable now <b>{money(max)}</b></p>
      )}

      {c.customer_text && (
        <div className="card pad">
          <div className="xs muted">Customer's message</div>
          <PlainText text={c.customer_text} />
        </div>
      )}

      {hints.map((h, i) => (
        <p key={i} className="hint small">
          <PlainText text={h} className="inline" />
        </p>
      ))}

      <div className="acts">
        {primary.map((a) => (
          <Button
            key={a}
            variant="primary"
            onClick={() => setSheet(a)}
            disabled={a === "approve" && approveDisabled}
          >
            {a === "approve" ? `Approve ${money(max)}` : a === "waive" ? `Waive ${money(owedTotal(page))}` : LABELS[a]}
          </Button>
        ))}
        {secondary.map((a) => (
          <Button key={a} onClick={() => setSheet(a)}>
            {LABELS[a] ?? words(a)}
          </Button>
        ))}
        <span className="right row gap4">
          {has("refresh_evidence") && (
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? "Working…" : "Refresh evidence"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSheet("close")}
            disabled={!has("close")}
            title={has("close") ? undefined : "Closed cases are final."}
          >
            Close
          </Button>
        </span>
      </div>
      {flash && <p className="ok small" role="status">{flash}</p>}
      {inlineErr && <p className="err small" role="alert">{inlineErr}</p>}

      <div className="two">
        <EvidencePanel evidence={page.evidence} n={c.evidence_n} />
        <section className="card">
          <div className="sh"><b>Timeline</b></div>
          <div className="tlbox">
            {has("note") && <NoteBox caseId={c.id} onPage={onPage} />}
            <Timeline page={page} />
          </div>
          <div className="sh topline"><b>Related cases</b></div>
          {(page.related_cases ?? []).length === 0 ? (
            <p className="muted xs pad">None for this account.</p>
          ) : (
            <table className="mini pad-table">
              <tbody>
                {(page.related_cases ?? []).map((r) => (
                  <tr key={r.id}>
                    <td><Link className="link mono" to={paths.case(r.id)}>{r.id}</Link></td>
                    <td>{words(r.type)} · {words(r.reason)}</td>
                    <td>{statusLabel(r.status, r.result)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(c.related.linked_case_ids ?? []).length > 0 && (
            <p className="xs pad">
              Linked:{" "}
              {(c.related.linked_case_ids ?? []).map((l) => (
                <Link key={l} className="link mono" to={paths.case(l)}>{l} </Link>
              ))}
            </p>
          )}
          <div className="sh topline"><b>Refunds</b></div>
          {(page.refunds ?? []).length === 0 ? (
            <p className="muted xs pad">No refunds on this payment.</p>
          ) : (
            <table className="mini pad-table">
              <tbody>
                {(page.refunds ?? []).map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.re_id || r.id}</td>
                    <td className="num">{money(r.total_cents)}</td>
                    <td>{words(r.status)}{r.fail_reason ? ` · ${r.fail_reason}` : ""}</td>
                    <td>{dateOnly(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {sheet && (
        <ActionSheet
          action={sheet}
          page={page}
          previews={previews}
          onClose={() => setSheet(null)}
          onDone={done}
          onReload={onReload}
        />
      )}
    </>
  );
}

function NoteBox({ caseId, onPage }: { caseId: string; onPage: (p: Page) => void }) {
  const { api } = useServices();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      onPage(await api.caseAction(caseId, { action: "note", text: text.trim() }));
      setText("");
    } catch (e) {
      setErr(
        e instanceof ApiError && e.code === "case_closed"
          ? "Reopen the case to add notes."
          : `That didn't work: ${errorMessage(e)}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="note">
      <textarea
        className="input"
        rows={2}
        placeholder="Add a note…"
        aria-label="Add a note"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button size="sm" onClick={() => void save()} disabled={busy || !text.trim()}>
        {busy ? "Working…" : "Add note"}
      </Button>
      {err && <p className="err xs" role="alert">{err}</p>}
    </div>
  );
}

function Timeline({ page }: { page: Page }) {
  const events = [...(page.events ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  if (events.length === 0) return <p className="muted xs">No events yet.</p>;
  return (
    <ol className="ctl">
      {events.map((e) => {
        const sys = e.who === "system";
        const cust = e.who === "customer";
        return (
          <li key={e.id || e.at + e.kind}>
            <span className={`who ${sys ? "sys" : cust ? "cust" : ""}`}>{sys ? "system" : cust ? "customer" : e.who}</span>
            <span className="t">
              {dateTime(e.at)} · {words(e.kind)}
            </span>
            {e.kind === "promo_restored" && e.data ? <PromoRestored data={e.data} /> : e.text && <PlainText text={e.text} />}
          </li>
        );
      })}
    </ol>
  );
}

type PromoGrantRow = { entitlement?: string; ends_at?: string | null };

/** An owner's restore of promotional grants on a closed dispute case (gateway 00107). */
function PromoRestored({ data }: { data: Record<string, unknown> }) {
  const rows = (v: unknown): PromoGrantRow[] => (Array.isArray(v) ? (v as PromoGrantRow[]) : []);
  const one = (g: PromoGrantRow) => {
    const name = words(g.entitlement || "pro");
    const ent = name.charAt(0).toUpperCase() + name.slice(1);
    return g.ends_at ? `${ent} until ${dateOnly(g.ends_at)}` : `${ent}, no end date`;
  };
  const regranted = rows(data.regranted);
  const skipped = rows(data.skipped);
  const by = typeof data.by === "string" ? data.by : "the owner";
  const reason = typeof data.reason === "string" ? data.reason : "";
  return (
    <div className="xs" data-testid="promo-restored">
      <PlainText text={`Promotional grants restored by ${by}${reason ? `: ${reason}` : ""}`} />
      <div>Given back: {regranted.length ? regranted.map(one).join(", ") : "none"}</div>
      {skipped.length > 0 && <div className="muted">Skipped (already ended): {skipped.map(one).join(", ")}</div>}
    </div>
  );
}
