import { useEffect, useState } from "react";

import { Chip, ErrorState, SkeletonRows, StateBox } from "../components/ui";
import type { CaseListQuery } from "../lib/api";
import { ago, ageHours, dateOnly, dateTime, money, until, words } from "../lib/format";
import { CASE_TYPES, REASONS, typeLabel, typeTone } from "../lib/labels";
import { Link, paths, useRouter } from "../lib/router";
import { useServices } from "../lib/services";
import type { CaseRow, CasesResponse, Tab } from "../lib/types";
import { useLoad } from "../lib/useLoad";

const TABS: { id: Tab; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "waiting", label: "Waiting" },
  { id: "decided", label: "Decided" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

const EMPTY: Record<Tab, string> = {
  open: "No open cases.",
  waiting: "No cases waiting on a customer or a run.",
  decided: "No decided cases.",
  closed: "No closed cases.",
  all: "No cases.",
};

/** A1: the start page. The gateway sorts disputes, EFW and failed refunds first. */
export function CasesList({ onCounts }: { onCounts?: (c: CasesResponse["counts"]) => void }) {
  const { api } = useServices();
  const [query, setQuery] = useState<CaseListQuery>({ tab: "open" });
  const [search, setSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => (q.q === search ? q : { ...q, q: search })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { state, retry } = useLoad(() => api.listCases(query), [api, JSON.stringify(query)]);
  const counts = state.kind === "loaded" ? state.data.counts : null;
  useEffect(() => {
    if (counts) onCounts?.(counts);
  }, [counts, onCounts]);

  const filter = (k: "type" | "reason" | "mode" | "cap", v: string) =>
    setQuery((q) => ({ ...q, [k]: v || undefined }));

  return (
    <>
      <div className="titlebar">
        <h1>Cases</h1>
        {counts && (
          <span className="kpis" aria-label="Case counts">
            <span><b>{counts.open}</b> open</span>
            <span className={counts.overdue ? "red" : ""}><b>{counts.overdue}</b> overdue</span>
            <span className={counts.due_today ? "amber" : ""}><b>{counts.due_today}</b> due today</span>
          </span>
        )}
      </div>
      <div className="tools">
        <div className="seg" role="tablist" aria-label="Case status">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={query.tab === t.id}
              className={query.tab === t.id ? "on" : ""}
              onClick={() => setQuery((q) => ({ ...q, tab: t.id }))}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select className="fsel" aria-label="Type" value={query.type ?? ""} onChange={(e) => filter("type", e.target.value)}>
          <option value="">Type</option>
          {CASE_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
        </select>
        <select className="fsel" aria-label="Reason" value={query.reason ?? ""} onChange={(e) => filter("reason", e.target.value)}>
          <option value="">Reason</option>
          {REASONS.map((r) => <option key={r} value={r}>{words(r)}</option>)}
        </select>
        <select className="fsel" aria-label="Mode" value={query.mode ?? ""} onChange={(e) => filter("mode", e.target.value)}>
          <option value="">Mode</option>
          <option value="manual">manual</option>
          <option value="auto">auto</option>
        </select>
        <select className="fsel" aria-label="Cap" value={query.cap ?? ""} onChange={(e) => filter("cap", e.target.value)}>
          <option value="">Cap</option>
          <option value="over">Over the cap</option>
          <option value="under">Under the cap</option>
        </select>
        <span className="grow" />
        <input
          className="input search"
          type="search"
          placeholder="Case, email, run, pi_…, re_…"
          aria-label="Search cases"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {state.kind === "loading" && <SkeletonRows rows={6} cols={8} />}
      {state.kind === "error" && <ErrorState title="Couldn't load cases." onRetry={retry} />}
      {state.kind === "loaded" &&
        ((state.data.cases ?? []).length === 0 ? (
          <StateBox title={query.q || query.type || query.reason || query.mode || query.cap ? "No cases match." : EMPTY[query.tab]} />
        ) : (
          <CaseTable rows={state.data.cases ?? []} />
        ))}
    </>
  );
}

function Deadline({ row }: { row: CaseRow }) {
  if (row.dispute_due) {
    return <span className="due bad">dispute due · {dateOnly(row.dispute_due)}</span>;
  }
  if (!row.deadline_at) return <span className="muted">—</span>;
  const overdue = new Date(row.deadline_at).getTime() < Date.now();
  if (row.deadline_red || overdue) {
    return <span className="due red">{until(row.deadline_at)}</span>;
  }
  return <span className="due">{dateTime(row.deadline_at)}</span>;
}

function CaseTable({ rows }: { rows: CaseRow[] }) {
  const { navigate } = useRouter();
  return (
    <div className="card scroll-x">
      <table className="at clickable">
        <thead>
          <tr>
            <th>Case</th>
            <th>Age</th>
            <th>Account</th>
            <th>Type · reason</th>
            <th className="num">Requested</th>
            <th className="num">Max refundable</th>
            <th>Deadline</th>
            <th>Last activity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => navigate(paths.case(r.id))}>
              <td>
                <Link to={paths.case(r.id)} className="cid mono" onClick={(e) => e.stopPropagation()}>
                  {r.id}
                </Link>
              </td>
              <td className="muted">{ageHours(r.age_hours)}</td>
              <td>{r.email_masked || <span className="muted">—</span>}</td>
              <td>
                <Chip tone={typeTone(r.type)}>{typeLabel(r.type)}</Chip>{" "}
                <span className="muted">{words(r.reason)}</span>
                {r.mode === "auto" && <span className="muted"> · auto</span>}
              </td>
              <td className="num">{money(r.requested_cents)}</td>
              <td className="num">{r.max_refundable_cents === undefined ? "—" : money(r.max_refundable_cents)}</td>
              <td><Deadline row={r} /></td>
              <td className="muted">{ago(r.last_activity_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
