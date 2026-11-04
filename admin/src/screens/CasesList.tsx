import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useOpenSearch } from "@/components/CommandMenu";
import { ErrorState, FilterSelect, PlainText, StateBox } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { CaseListQuery } from "../lib/api";
import { ageHours, dateOnly, dateTime, money, time, until, words } from "../lib/format";
import { CASE_TYPES, REASONS, typeLabel, typeTone } from "../lib/labels";
import { Link, paths, useRouter } from "../lib/router";
import type { CaseRow, Tab } from "../lib/types";
import { casesQuery } from "@/state/queries";
import { useQuery } from "@/state/query";

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

/**
 * The list's filters and the selected case (ADR 0138): atoms, so coming
 * back from a case finds the same tab, filters and row.
 */
const casesFilterAtom = atom<CaseListQuery>({ tab: "open" });
const casesSelectedAtom = atom<string | null>(null);
/** Changes the filters; a new filter starts again at the top. */
const updateCasesFilterAtom = atom(null, (get, set, update: (q: CaseListQuery) => CaseListQuery) => {
  const q = get(casesFilterAtom);
  const next = update(q);
  if (next === q) return;
  set(casesFilterAtom, next);
  set(casesSelectedAtom, null);
});

/** Typing in these never moves the list. */
function editable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.getAttribute("role") === "combobox");
}

/**
 * A1 (BL-29 redesign B): the list on the left, the selected case's preview
 * on the right (wide screens). The gateway sorts disputes, EFW and failed
 * refunds first. Keys, while the focus is on the page and not in a field:
 * J / K or ↓ / ↑ move, ↵ opens the case, D opens it with the decision
 * sheet, E opens the account.
 */
export function CasesList() {
  const { navigate } = useRouter();
  const query = useAtomValue(casesFilterAtom);
  const setQuery = useSetAtom(updateCasesFilterAtom);
  const [selectedId, setSelectedId] = useAtom(casesSelectedAtom);
  // the search box's text before its debounce: local UI
  const [search, setSearch] = useState(query.q ?? "");
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => ((q.q ?? "") === search ? q : { ...q, q: search })), 300);
    return () => clearTimeout(t);
  }, [search, setQuery]);

  const { state, retry } = useQuery(casesQuery, query);
  const counts = state.kind === "loaded" ? state.data.counts : null;
  const rows = state.kind === "loaded" ? state.data.cases ?? [] : [];
  const found = rows.findIndex((r) => r.id === selectedId);
  const selected = found < 0 ? 0 : found;
  const current = rows[selected] ?? null;

  const filter = (k: "type" | "reason" | "mode" | "cap", v: string) => setQuery((q) => ({ ...q, [k]: v || undefined }));

  const move = (to: number) => {
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, to));
    setSelectedId(rows[i].id);
    listRef.current?.querySelectorAll<HTMLElement>("[data-case-link]")[i]?.focus();
  };

  // Bound on the page, not the document: keys never leak into the rest of
  // the console, and typing in the search or a filter is left alone.
  const onKeyDown = (e: KeyboardEvent) => {
    if (editable(e.target) || e.metaKey || e.ctrlKey || e.altKey || !current) return;
    const k = e.key;
    if (k === "j" || k === "ArrowDown") move(selected + 1);
    else if (k === "k" || k === "ArrowUp") move(selected - 1);
    else if (k === "d") navigate(paths.case(current.id, { decide: true }));
    else if (k === "e" && current.uid) navigate(paths.account(current.uid));
    else return;
    e.preventDefault();
  };

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Cases</h1>
        {counts && (
          <span className="flex gap-4 text-sm text-muted-foreground" aria-label="Case counts">
            <span>
              <b className="font-semibold text-foreground tabular-nums">{counts.open}</b> open
            </span>
            <span className={cn(counts.overdue > 0 && "text-destructive-foreground")}>
              <b className={cn("font-semibold tabular-nums", counts.overdue > 0 ? "text-destructive-foreground" : "text-foreground")}>
                {counts.overdue}
              </b>{" "}
              overdue
            </span>
            <span className={cn(counts.due_today > 0 && "text-warning-foreground")}>
              <b className={cn("font-semibold tabular-nums", counts.due_today > 0 ? "text-warning-foreground" : "text-foreground")}>
                {counts.due_today}
              </b>{" "}
              due today
            </span>
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={query.tab} onValueChange={(t) => setQuery((q) => ({ ...q, tab: t as Tab }))}>
          <TabsList aria-label="Case status">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="text-[12.5px] max-md:min-h-9">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <FilterSelect label="Type" allLabel="Type" value={query.type ?? ""} onChange={(v) => filter("type", v)} options={CASE_TYPES.map((t) => ({ value: t, label: typeLabel(t) }))} />
        <FilterSelect label="Reason" allLabel="Reason" value={query.reason ?? ""} onChange={(v) => filter("reason", v)} options={REASONS.map((r) => ({ value: r, label: words(r) }))} />
        <FilterSelect
          label="Mode"
          allLabel="Mode"
          value={query.mode ?? ""}
          onChange={(v) => filter("mode", v)}
          options={[
            { value: "manual", label: "manual" },
            { value: "auto", label: "auto" },
          ]}
        />
        <FilterSelect
          label="Cap"
          allLabel="Cap"
          value={query.cap ?? ""}
          onChange={(v) => filter("cap", v)}
          options={[
            { value: "over", label: "Over the cap" },
            { value: "under", label: "Under the cap" },
          ]}
        />
        <Input
          className="ml-auto w-70 max-[1000px]:ml-0 max-[1000px]:w-full"
          type="search"
          placeholder="Case, email, run, pi_…, re_…"
          aria-label="Search cases"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {state.kind === "loading" && <ListSkeleton />}
      {state.kind === "error" && <ErrorState title="Couldn't load cases." onRetry={retry} />}
      {state.kind === "loaded" &&
        (rows.length === 0 ? (
          <StateBox title={query.q || query.type || query.reason || query.mode || query.cap ? "No cases match." : EMPTY[query.tab]} />
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
            <ul
              ref={listRef}
              aria-label="Cases"
              className="list-none overflow-hidden rounded-xl border border-border bg-card"
              data-testid="case-list"
            >
              {rows.map((r) => (
                <li key={r.id} data-testid="case-row">
                  <CaseRowLink row={r} selected={current?.id === r.id} onFocus={() => setSelectedId(r.id)} />
                </li>
              ))}
            </ul>
            <Preview row={current} />
          </div>
        ))}
    </div>
  );
}

function ListSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading" className="list-none overflow-hidden rounded-xl border border-border bg-card lg:max-w-[560px]">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} data-testid="skeleton-row" className="flex flex-col gap-2 border-b border-border-soft px-4 py-3 last:border-b-0">
          <Skeleton className="w-1/2" />
          <Skeleton className="w-1/3" />
        </li>
      ))}
    </ul>
  );
}

/** Red = overdue or money at risk, amber = due today, grey = later. */
function urgency(r: CaseRow): { tone: "red" | "amber" | "grey"; text: string } {
  if (r.dispute_due) {
    const at = Date.parse(r.dispute_due);
    return { tone: at - Date.now() < 24 * 3600e3 ? "red" : "grey", text: `dispute due · ${dateOnly(r.dispute_due)}` };
  }
  if (r.type === "efw" || r.reason === "refund_failed") {
    return { tone: "red", text: r.deadline_at ? until(r.deadline_at) : "money at risk" };
  }
  if (!r.deadline_at) return { tone: "grey", text: "—" };
  const at = Date.parse(r.deadline_at);
  if (r.deadline_red || at < Date.now()) return { tone: "red", text: until(r.deadline_at) };
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  if (at <= end.getTime()) return { tone: "amber", text: `today ${time(r.deadline_at)}` };
  return { tone: "grey", text: dateTime(r.deadline_at) };
}

const DOT = { red: "bg-destructive", amber: "bg-warning", grey: "bg-neutral" };
const DUE = { red: "text-destructive-foreground", amber: "text-warning-foreground", grey: "text-neutral-foreground" };

function CaseRowLink({ row: r, selected, onFocus }: { row: CaseRow; selected: boolean; onFocus: () => void }) {
  const u = urgency(r);
  const cents = r.max_refundable_cents ?? r.requested_cents;
  return (
    <Link
      to={paths.case(r.id)}
      data-case-link
      aria-current={selected ? "true" : undefined}
      onFocus={onFocus}
      className={cn(
        "flex min-h-11 flex-col gap-1 border-b border-border-soft px-4 py-2.75 text-foreground hover:bg-accent/40 focus-visible:-outline-offset-2",
        selected && "bg-[color-mix(in_oklch,var(--card),var(--foreground)_3%)] shadow-[inset_2px_0_0_var(--ring)]",
      )}
    >
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className={cn("size-1.75 shrink-0 rounded-full", DOT[u.tone])} />
        <span className="font-mono text-xs text-foreground-2">{r.id}</span>
        <Badge variant={typeTone(r.type)}>{typeLabel(r.type)}</Badge>
        <span className="truncate text-sm text-muted-foreground">{words(r.reason)}</span>
        <span className="ml-auto font-mono text-sm tabular-nums">{cents === undefined ? "—" : money(cents)}</span>
      </span>
      <span className="flex justify-between gap-2 pl-3.75 text-xs text-muted-foreground">
        <span className="truncate">
          {r.email_masked || "—"} · <span className="tabular-nums">{ageHours(r.age_hours)}</span>
          {r.mode === "auto" && " · auto"}
        </span>
        <span className={cn("whitespace-nowrap tabular-nums", DUE[u.tone])}>{u.text}</span>
      </span>
    </Link>
  );
}

/** The selected row, from the list itself (uid since gateway rev 00114;
 * message_excerpt and run_ids since cf7c121, absent on older gateways):
 * no request per selection. A run id opens ⌘K's run lookup. */
function Preview({ row }: { row: CaseRow | null }) {
  const openSearch = useOpenSearch();
  if (!row) return null;
  const u = urgency(row);
  return (
    <section aria-label="Case preview" className="sticky top-18 flex flex-col gap-3.5 rounded-xl border border-border bg-card p-5 max-lg:hidden">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="font-mono text-lg font-medium">{row.id}</h2>
        <Badge variant={typeTone(row.type)}>{typeLabel(row.type)}</Badge>
        <span className={cn("text-xs tabular-nums", DUE[u.tone])}>{u.text}</span>
        <Button asChild variant="default" size="sm" className="ml-auto">
          <Link to={paths.case(row.id, { decide: true })}>Decide</Link>
        </Button>
      </div>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-2.5 text-sm max-xl:grid-cols-1 [&_dt]:text-xs [&_dt]:text-muted-foreground">
        <div>
          <dt>Customer</dt>
          <dd>
            {row.uid ? (
              <Link to={paths.account(row.uid)} className="text-link hover:underline">
                {row.email_masked || row.uid}
              </Link>
            ) : (
              row.email_masked || "—"
            )}
          </dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>
            {words(row.reason)} · {row.mode}
          </dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd className="font-mono tabular-nums">{money(row.requested_cents)}</dd>
        </div>
        <div>
          <dt>Refundable now</dt>
          <dd className="font-mono tabular-nums">{row.max_refundable_cents === undefined ? "—" : money(row.max_refundable_cents)}</dd>
        </div>
        <div>
          <dt>Opened</dt>
          <dd className="tabular-nums">
            {dateTime(row.opened_at)} · {ageHours(row.age_hours)} ago
          </dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd className="tabular-nums">{dateTime(row.last_activity_at)}</dd>
        </div>
        {Array.isArray(row.run_ids) && row.run_ids.length > 0 && (
          <div className="col-span-full">
            <dt>Runs</dt>
            <dd className="flex flex-wrap gap-x-3 gap-y-1" data-testid="preview-runs">
              {row.run_ids.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="rounded-sm font-mono text-xs text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Look up run ${id}`}
                  onClick={() => openSearch(id)}
                >
                  {id}
                </button>
              ))}
            </dd>
          </div>
        )}
      </dl>
      {row.message_excerpt && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-background px-3.5 py-3" data-testid="preview-message">
          <span className="text-xs text-muted-foreground">Customer's message</span>
          <PlainText text={row.message_excerpt} className="text-sm text-foreground" />
        </div>
      )}
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Kbd>J</Kbd> <Kbd>K</Kbd> to move, <Kbd>↵</Kbd> to open, <Kbd>D</Kbd> to decide{row.uid ? <>, <Kbd>E</Kbd> for the account</> : null}.
      </p>
    </section>
  );
}
