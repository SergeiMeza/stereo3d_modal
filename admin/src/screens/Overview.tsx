import { useState } from "react";

import { EmptyRow, Panel, StateBox } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAttention } from "@/lib/attention";
import { ago, money, pct, time } from "@/lib/format";
import { nextUpCopy, type Lane, type LaneItem } from "@/lib/lanes";
import { Link, paths, useRouter } from "@/lib/router";
import { useServices } from "@/lib/services";
import { useLoad } from "@/lib/useLoad";
import { cn } from "@/lib/utils";

/**
 * Needs attention (BL-29 redesign B, with C's Next up card): the one thing
 * to do first, then Now / Today / This week from the open cases and the
 * disputes summary, then plan starts, new feedback and passkey adoption.
 */

const LANES: { id: Lane; name: string; dot: string; due: string }[] = [
  { id: "now", name: "Now: overdue or money at risk", dot: "bg-destructive", due: "text-destructive-foreground" },
  { id: "today", name: "Today", dot: "bg-warning", due: "text-warning-foreground" },
  { id: "week", name: "This week", dot: "bg-neutral", due: "text-neutral-foreground" },
];

const PRODUCTS = { pro: "Pro", business: "Business", studio: "Studio" } as const;

export function OverviewPage() {
  const a = useAttention();
  const [skipped, setSkipped] = useState<string[]>([]);
  const loading = a.updatedAt === null;
  const urgent = a.lanes.filter((l) => l.lane !== "week").length;
  const next = a.lanes.find((l) => !skipped.includes(l.key)) ?? null;
  const today = new Date().toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Needs attention</h1>
        <span className="text-sm text-muted-foreground tabular-nums">
          {today}
          {a.cases && ` · ${a.cases.counts.open} open`}
          {a.updatedAt && ` · updated ${time(new Date(a.updatedAt).toISOString())}`}
        </span>
        {!loading && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={a.refresh}>
            Refresh
          </Button>
        )}
      </div>

      {loading ? (
        <Skeleton className="h-36 rounded-2xl" />
      ) : next ? (
        <NextUp item={next} remaining={urgent} onSkip={() => setSkipped((s) => [...s, next.key])} />
      ) : a.cases ? (
        <StateBox title="Nothing needs you right now.">Open cases with a deadline and open disputes show up here.</StateBox>
      ) : (
        <StateBox tone="error" title="Couldn't load the open cases." action={<Button size="sm" onClick={a.refresh}>Try again</Button>} />
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-start gap-3.5">
        {LANES.map((lane) => {
          const items = a.lanes.filter((l) => l.lane === lane.id);
          return (
            <section key={lane.id} aria-labelledby={`lane-${lane.id}`} className="rounded-xl border border-border bg-card" data-testid={`lane-${lane.id}`}>
              <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
                <span aria-hidden="true" className={cn("size-2 rounded-full", lane.dot)} />
                <h2 id={`lane-${lane.id}`} className="text-sm font-semibold">{lane.name}</h2>
                <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">{loading ? "" : items.length}</span>
              </div>
              {loading ? (
                <div className="flex flex-col gap-3 px-3.5 py-3" aria-busy="true" aria-label="Loading">
                  <Skeleton />
                  <Skeleton className="w-2/3" />
                </div>
              ) : items.length === 0 ? (
                <EmptyRow>Nothing here.</EmptyRow>
              ) : (
                <ul className="list-none">
                  {items.map((i) => (
                    <li key={i.key}>
                      <LaneRow item={i} dueCls={lane.due} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-start gap-3.5">
        <PlanStarts />
        <NewFeedback />
        <PasskeyAdoptionCard />
      </div>
    </>
  );
}

function LaneRow({ item, dueCls }: { item: LaneItem; dueCls: string }) {
  return (
    <Link
      to={item.href}
      className="flex flex-col gap-1 border-b border-border-soft px-3.5 py-2.75 text-foreground last:border-b-0 hover:bg-accent/50 focus-visible:-outline-offset-2"
    >
      <span className="flex justify-between gap-2">
        <span className="text-sm font-medium">{item.what}</span>
        <span className="font-mono text-sm tabular-nums">{item.cents === null ? "—" : money(item.cents)}</span>
      </span>
      <span className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">
          <span className="font-mono">{item.id}</span>
          {item.who && ` · ${item.who}`}
        </span>
        <span className={cn("whitespace-nowrap tabular-nums", dueCls)}>{item.due}</span>
      </span>
    </Link>
  );
}

/** C's "Next up": the first thing to do, why, and the way in. */
function NextUp({ item, remaining, onSkip }: { item: LaneItem; remaining: number; onSkip: () => void }) {
  const { navigate } = useRouter();
  const copy = nextUpCopy(item);
  const red = item.lane === "now";
  return (
    <section
      aria-label="Next up"
      className={cn(
        "flex flex-col gap-3 rounded-2xl border bg-card p-5.5",
        red ? "border-destructive/40" : item.lane === "today" ? "border-warning/35" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          className={cn(
            "text-xs font-semibold tracking-[0.06em] uppercase",
            red ? "text-destructive-foreground" : item.lane === "today" ? "text-warning-foreground" : "text-neutral-foreground",
          )}
        >
          Next up · {item.due}
        </span>
        <span className="font-mono text-sm text-muted-foreground">{item.id}</span>
        {remaining > 1 && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{remaining - 1} more today</span>}
      </div>
      <h2 className="text-xl font-semibold">{copy.title}</h2>
      <p className="max-w-[70ch] text-base text-foreground-2">
        {item.who && item.who !== "no case" ? `${item.who}. ` : ""}
        {copy.body}
      </p>
      <div className="flex flex-wrap gap-2.5">
        {item.caseId ? (
          <>
            <Button variant="default" size="lg" onClick={() => navigate(paths.case(item.caseId!, { decide: true }))}>
              Decide{item.cents !== null ? ` on ${money(item.cents)}` : ""}
            </Button>
            <Button size="lg" onClick={() => navigate(paths.case(item.caseId!))}>
              Open case
            </Button>
          </>
        ) : (
          <Button variant="default" size="lg" onClick={() => navigate(paths.disputes())}>
            Open disputes
          </Button>
        )}
        <Button variant="ghost" size="lg" onClick={onSkip}>
          Skip for now
        </Button>
      </div>
    </section>
  );
}

/** Plan starts in the last 7 days, by plan (the gateway's plans surfaces). */
function PlanStarts() {
  const { api } = useServices();
  const { state } = useLoad(() => api.plansSurfaces(7), [api]);
  return (
    <Panel title="Plan starts this week" action={<Link to={paths.plans()} className="text-sm text-link hover:underline">Surfaces</Link>}>
      {state.kind === "loading" && (
        <div className="px-4 py-3" aria-busy="true" aria-label="Loading">
          <Skeleton />
        </div>
      )}
      {state.kind === "error" && <EmptyRow>Couldn't load the plan starts.</EmptyRow>}
      {state.kind === "loaded" &&
        (() => {
          const by: Record<string, number> = {};
          for (const r of state.data.placements ?? [])
            for (const [k, v] of Object.entries(r.conversions_by_product ?? {})) by[k] = (by[k] ?? 0) + (v ?? 0);
          for (const [k, v] of Object.entries(state.data.unattributed?.by_product ?? {})) by[k] = (by[k] ?? 0) + (v ?? 0);
          const total = Object.values(by).reduce((s, v) => s + v, 0);
          if (!total) return <EmptyRow>No plan starts in the last 7 days.</EmptyRow>;
          return (
            <dl className="flex flex-col gap-1.5 px-4 py-3 text-sm" data-testid="plan-starts">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">All plans</dt>
                <dd className="font-mono font-medium tabular-nums">{total}</dd>
              </div>
              {(Object.keys(PRODUCTS) as (keyof typeof PRODUCTS)[])
                .filter((k) => by[k])
                .map((k) => (
                  <div key={k} className="flex justify-between">
                    <dt>{PRODUCTS[k]}</dt>
                    <dd className="font-mono tabular-nums">{by[k]}</dd>
                  </div>
                ))}
            </dl>
          );
        })()}
    </Panel>
  );
}

/** The latest feedback (7 days), from the attention poll. */
function NewFeedback() {
  const a = useAttention();
  const items = a.feedback ?? [];
  return (
    <Panel
      title="New feedback"
      action={
        <Link to={paths.feedback()} className="text-sm text-link hover:underline">
          All{items.length ? ` ${items.length}` : ""}
        </Link>
      }
    >
      {a.feedback === null ? (
        <EmptyRow>{a.updatedAt === null ? "Loading…" : "Couldn't load the feedback."}</EmptyRow>
      ) : items.length === 0 ? (
        <EmptyRow>No feedback in the last 7 days.</EmptyRow>
      ) : (
        <ul className="flex list-none flex-col gap-2.5 px-4 py-3" data-testid="overview-feedback">
          {items.slice(0, 3).map((f) => (
            <li key={f.id} className="flex flex-col gap-0.5">
              <span className="line-clamp-2 text-sm [overflow-wrap:anywhere]">“{f.message}”</span>
              <span className="text-xs text-muted-foreground">
                {f.platform === "web" ? "Web" : "App"} · {ago(f.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Customer passkeys (ADR 0136; gateway rev 00113). */
function PasskeyAdoptionCard() {
  const { api } = useServices();
  const { state } = useLoad(() => api.passkeyAdoption(), [api]);
  if (state.kind === "error") return null;
  return (
    <Panel title="Customer passkeys" note="sign-ins by method">
      {state.kind === "loading" ? (
        <div className="px-4 py-3" aria-busy="true" aria-label="Loading">
          <Skeleton />
        </div>
      ) : (
        (() => {
          const d = state.data;
          const share = (w: "7d" | "30d") => {
            const m = d.sign_ins?.[w] ?? {};
            const all = Object.values(m).reduce((s, v) => s + v, 0);
            return all ? pct((m.passkey ?? 0) / all, 0) : "—";
          };
          return (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-sm" data-testid="passkey-adoption">
              <div>
                <dt className="text-xs text-muted-foreground">Accounts with a passkey</dt>
                <dd className="font-mono text-lg tabular-nums">{d.accounts_with_passkey}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Passkeys</dt>
                <dd className="font-mono text-lg tabular-nums">{d.passkeys}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Passkey sign-ins, 7 days</dt>
                <dd className="font-mono tabular-nums">{share("7d")}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Passkey sign-ins, 30 days</dt>
                <dd className="font-mono tabular-nums">{share("30d")}</dd>
              </div>
            </dl>
          );
        })()
      )}
    </Panel>
  );
}
