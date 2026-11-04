import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { ErrorState, FilterSelect, PlainText, StateBox } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ApiError, errorMessage, type CaseListQuery } from "../lib/api";
import { ageHours, dateOnly, dateTime, money, time, until, words } from "../lib/format";
import { CASE_TYPES, REASONS, typeLabel, typeTone } from "../lib/labels";
import { Link, paths, useRouter } from "../lib/router";
import { useServices } from "../lib/services";
import type { CasePage, CaseRow, Tab } from "../lib/types";
import { useLoad, type Load } from "../lib/useLoad";

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
  const { api } = useServices();
  const { navigate } = useRouter();
  const [query, setQuery] = useState<CaseListQuery>({ tab: "open" });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => (q.q === search ? q : { ...q, q: search })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { state, retry } = useLoad(() => api.listCases(query), [api, JSON.stringify(query)]);
  const counts = state.kind === "loaded" ? state.data.counts : null;
  const rows = state.kind === "loaded" ? state.data.cases ?? [] : [];
  const current = rows[Math.min(selected, rows.length - 1)] ?? null;

  useEffect(() => setSelected(0), [JSON.stringify(query)]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = useLoad(() => (current ? api.getCase(current.id) : Promise.resolve(null)), [api, current?.id]);
  const previewUid = preview.state.kind === "loaded" ? preview.state.data?.case.uid : undefined;

  const filter = (k: "type" | "reason" | "mode" | "cap", v: string) => setQuery((q) => ({ ...q, [k]: v || undefined }));

  const move = (to: number) => {
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, to));
    setSelected(i);
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
    else if (k === "e" && previewUid) navigate(paths.account(previewUid));
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
              {rows.map((r, i) => (
                <li key={r.id} data-testid="case-row">
                  <CaseRowLink row={r} selected={current?.id === r.id} onFocus={() => setSelected(i)} />
                </li>
              ))}
            </ul>
            <Preview row={current} state={preview.state} />
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

function Preview({ row, state }: { row: CaseRow | null; state: Load<CasePage | null> }) {
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
      {state.kind === "loading" && <Spinner label="Loading the preview" />}
      {state.kind === "error" && (
        <p className="text-sm text-muted-foreground">
          {state.error instanceof ApiError && state.error.status === 404 ? "This case is gone." : `Couldn't load the preview: ${errorMessage(state.error)}`}
        </p>
      )}
      {state.kind === "loaded" && state.data && (
        <>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-2.5 text-sm max-xl:grid-cols-1 [&_dt]:text-xs [&_dt]:text-muted-foreground">
            <div>
              <dt>Customer</dt>
              <dd>
                {state.data.case.uid ? (
                  <Link to={paths.account(state.data.case.uid)} className="text-link hover:underline">
                    {state.data.account.email || state.data.case.uid}
                  </Link>
                ) : (
                  state.data.account.email || "—"
                )}
              </dd>
            </div>
            <div>
              <dt>Runs</dt>
              <dd className="font-mono text-xs">{(state.data.runs ?? []).map((r) => r.conversion_id).join(", ") || "—"}</dd>
            </div>
            <div>
              <dt>Refundable now</dt>
              <dd className="font-mono tabular-nums">
                {money(state.data.max_refundable_cents)}
                {state.data.account.payment_method ? ` · ${state.data.account.payment_method}` : ""}
              </dd>
            </div>
            <div>
              <dt>Earlier cases</dt>
              <dd className="tabular-nums">{(state.data.related_cases ?? []).length || "none"}</dd>
            </div>
          </dl>
          {state.data.case.customer_text && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-background px-3.5 py-3">
              <span className="text-xs text-muted-foreground">Customer's message · {dateTime(state.data.case.opened_at)}</span>
              <PlainText text={state.data.case.customer_text} className="text-sm text-foreground" />
            </div>
          )}
        </>
      )}
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Kbd>J</Kbd> <Kbd>K</Kbd> to move, <Kbd>↵</Kbd> to open, <Kbd>D</Kbd> to decide, <Kbd>E</Kbd> for the account.
      </p>
    </section>
  );
}
