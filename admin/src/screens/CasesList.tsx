import { useEffect, useState } from "react";

import { ErrorState, FilterSelect, PageHeader, SkeletonRows, StateBox } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
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
      <PageHeader title="Cases">
        {counts && (
          <span className="flex gap-4 text-muted-foreground" aria-label="Case counts">
            <span><b className="font-semibold text-foreground tabular-nums">{counts.open}</b> open</span>
            <span className={cn(counts.overdue > 0 && "text-destructive")}>
              <b className={cn("font-semibold tabular-nums", counts.overdue > 0 ? "text-destructive" : "text-foreground")}>{counts.overdue}</b> overdue
            </span>
            <span className={cn(counts.due_today > 0 && "text-warning")}>
              <b className={cn("font-semibold tabular-nums", counts.due_today > 0 ? "text-warning" : "text-foreground")}>{counts.due_today}</b> due today
            </span>
          </span>
        )}
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={query.tab} onValueChange={(t) => setQuery((q) => ({ ...q, tab: t as Tab }))}>
          <TabsList aria-label="Case status">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="text-[12.5px]">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <FilterSelect
          label="Type"
          allLabel="Type"
          value={query.type ?? ""}
          onChange={(v) => filter("type", v)}
          options={CASE_TYPES.map((t) => ({ value: t, label: typeLabel(t) }))}
        />
        <FilterSelect
          label="Reason"
          allLabel="Reason"
          value={query.reason ?? ""}
          onChange={(v) => filter("reason", v)}
          options={REASONS.map((r) => ({ value: r, label: words(r) }))}
        />
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
        <span className="flex-1" />
        <Input
          className="w-70 max-[1000px]:w-full"
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
    return (
      <span className="rounded-full border border-destructive/40 bg-destructive/15 px-2 py-px text-xs whitespace-nowrap text-destructive-foreground">
        dispute due · {dateOnly(row.dispute_due)}
      </span>
    );
  }
  if (!row.deadline_at) return <span className="text-muted-foreground">—</span>;
  const overdue = new Date(row.deadline_at).getTime() < Date.now();
  if (row.deadline_red || overdue) {
    return <span className="text-xs font-medium whitespace-nowrap text-destructive">{until(row.deadline_at)}</span>;
  }
  return <span className="text-xs whitespace-nowrap text-foreground-2">{dateTime(row.deadline_at)}</span>;
}

function CaseTable({ rows }: { rows: CaseRow[] }) {
  const { navigate } = useRouter();
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Case</TableHead>
            <TableHead>Age</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Type · reason</TableHead>
            <TableHead numeric>Requested</TableHead>
            <TableHead numeric>Max refundable</TableHead>
            <TableHead>Deadline</TableHead>
            <TableHead>Last activity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} className="cursor-pointer hover:bg-primary/5" onClick={() => navigate(paths.case(r.id))}>
              <TableCell>
                <Link to={paths.case(r.id)} className="font-mono font-medium text-link" onClick={(e) => e.stopPropagation()}>
                  {r.id}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">{ageHours(r.age_hours)}</TableCell>
              <TableCell>{r.email_masked || <span className="text-muted-foreground">—</span>}</TableCell>
              <TableCell>
                <Badge variant={typeTone(r.type)}>{typeLabel(r.type)}</Badge>{" "}
                <span className="text-muted-foreground">{words(r.reason)}</span>
                {r.mode === "auto" && <span className="text-muted-foreground"> · auto</span>}
              </TableCell>
              <TableCell numeric>{money(r.requested_cents)}</TableCell>
              <TableCell numeric>{r.max_refundable_cents === undefined ? "—" : money(r.max_refundable_cents)}</TableCell>
              <TableCell><Deadline row={r} /></TableCell>
              <TableCell className="text-muted-foreground">{ago(r.last_activity_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
