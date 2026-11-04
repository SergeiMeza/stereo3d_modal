import { useState } from "react";

import type { ReactNode } from "react";

import { EmptyRow, ErrorState, ExtLink, FilterSelect, MiniTable, Note, PageHeader, Panel, SkeletonRows } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage } from "../lib/api";
import { dateOnly, dateTime, money, monthLabel, pct, until, words } from "../lib/format";
import { Link, paths } from "../lib/router";
import { useServices } from "../lib/services";
import type { DisputeMonth, DisputeSummary } from "../lib/types";
import { disputesQuery, efwsQuery } from "@/state/queries";
import { useQuery } from "@/state/query";

/** A4: disputes and fraud (BL-11 monitoring). */
export function DisputesPanel() {
  const { api } = useServices();
  const [months, setMonths] = useState(12);
  const { state, retry } = useQuery(disputesQuery, months);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvErr, setCsvErr] = useState("");

  const downloadCsv = async () => {
    setCsvBusy(true);
    setCsvErr("");
    try {
      const blob = await api.disputesCsv(months);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `stereo3d-disputes-${months}m.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setCsvErr(`Couldn't download the CSV: ${errorMessage(err)}`);
    } finally {
      setCsvBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Disputes and fraud"
        actions={
          <>
            <FilterSelect
              label="Months"
              value={String(months)}
              onChange={(v) => setMonths(Number(v))}
              options={[
                { value: "6", label: "Last 6 months" },
                { value: "12", label: "Last 12 months" },
                { value: "24", label: "Last 24 months" },
              ]}
            />
            <Button size="sm" onClick={() => void downloadCsv()} disabled={csvBusy}>
              {csvBusy ? "Working…" : "Export CSV"}
            </Button>
            {state.kind === "loaded" && <ExtLink href={state.data.account_wide}>Whole Stripe account</ExtLink>}
          </>
        }
      >
        <span className="text-sm text-muted-foreground">Web app charges only · refreshed on load</span>
      </PageHeader>
      {csvErr && <Note tone="error">{csvErr}</Note>}
      {state.kind === "loading" && <SkeletonRows rows={4} cols={4} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load disputes." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && <Summary data={state.data} months={months} />}
    </>
  );
}

function sum(rows: DisputeMonth[], k: keyof DisputeMonth): number {
  return rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
}

function Summary({ data, months }: { data: DisputeSummary; months: number }) {
  const rows = data.months ?? [];
  const ref = data.reference_pct || 0.0075;
  const disputes = sum(rows, "disputes_activity");
  const charges = sum(rows, "charges");
  const avg = charges ? disputes / charges : 0;
  const won = sum(rows, "won");
  const lost = sum(rows, "lost");
  const countered = sum(rows, "countered");
  const open = data.open ?? [];
  const over = rows.filter((r) => r.activity_pct >= ref);
  const lostCents = data.lost_cents ?? sum(rows, "lost_cents");
  const wonCents = data.won_cents ?? sum(rows, "won_cents");

  return (
    <>
      <RateHero rows={rows} reference={ref} />
      <div className={TWO}>
        <Panel title="Open disputes" note={<span className="font-mono tabular-nums">{open.length}</span>}>
          {open.length === 0 ? (
            <EmptyRow>No open disputes.</EmptyRow>
          ) : (
            <ul className="list-none" data-testid="open-disputes">
              {[...open]
                .sort((x, y) => (x.due_by ?? "9").localeCompare(y.due_by ?? "9"))
                .map((d) => {
                  const at = d.due_by ? Date.parse(d.due_by) : null;
                  const tone = at === null ? "grey" : at - Date.now() < 24 * 3600e3 ? "red" : at - Date.now() < 3 * 24 * 3600e3 ? "amber" : "grey";
                  return (
                    <li key={d.dispute_id} className="flex flex-col gap-1 border-b border-border-soft px-3.5 py-2.75 last:border-b-0">
                      <span className="flex justify-between gap-2">
                        <span className="text-sm font-medium">{words(d.reason)}</span>
                        <span className="font-mono text-sm tabular-nums">{money(d.amount_cents)}</span>
                      </span>
                      <span className="flex justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                          {d.case_id ? (
                            <Link className="font-mono text-link hover:underline" to={paths.case(d.case_id)}>{d.case_id}</Link>
                          ) : (
                            "no case"
                          )}{" "}
                          · {words(d.status)} · <span className="font-mono">{d.dispute_id}</span>
                        </span>
                        <span className={cn("whitespace-nowrap tabular-nums", TONE_TEXT[tone])}>
                          {d.due_by ? `evidence ${dateOnly(d.due_by).replace(/, \d{4}$/, "")} · ${until(d.due_by)}` : "—"}
                        </span>
                      </span>
                    </li>
                  );
                })}
            </ul>
          )}
        </Panel>
        <Panel
          title="Early fraud warnings"
          note={
            <span className={cn("font-mono tabular-nums", data.open_efws ? "text-destructive-foreground" : "")}>
              {data.open_efws ?? 0} open
            </span>
          }
        >
          <EfwList />
          <div className="flex flex-col gap-2 border-t border-border px-4 py-3 text-sm">
            <p className="text-xs text-muted-foreground tabular-nums">
              {months} months: {sum(rows, "efw")} warnings, {money(sum(rows, "efw_cents"))}, {sum(rows, "efw_refunded")} refunded,{" "}
              {sum(rows, "efw_became_disputes")} became disputes. Outcomes: {won} won ({money(wonCents)} recovered), {lost} lost ({money(lostCents)}).
            </p>
          </div>
        </Panel>
      </div>

      <Stats card>
        <Stat value={String(disputes)} label={`disputes, ${months} months`} sub="by dispute date" />
        <Stat
          value={pct(avg)}
          label="dispute activity"
          sub={`${months}-month average · line ${pct(ref)}`}
          tone={avg >= ref ? "red" : undefined}
          info={
            <>
              Disputes opened in a month ÷ successful charges that month. Card networks treat {pct(ref)} as excessive; Visa
              also counts early fraud warnings and can act below it.
            </>
          }
        />
        <Stat value={pct(data.counter_rate, 0)} label="countered" sub={`${countered} of ${disputes}`} />
        <Stat value={pct(data.win_rate, 0)} label="won" sub={`${won} of ${won + lost} decided`} />
      </Stats>
      {over.length > 0 && (
        <Note tone="error">Over the {pct(ref)} line in {over.map((r) => monthLabel(r.month)).join(", ")}.</Note>
      )}

      <div className={TWO}>
        <Panel title="Dispute activity by month" note="disputes ÷ successful charges">
          <ActivityChart rows={rows} reference={ref} />
        </Panel>
        <Panel title="Disputes by outcome" note="by dispute date">
          <OutcomeChart rows={rows} />
        </Panel>
      </div>

      <div className={TWO}>
        <Panel title="Money" note="fees in the account's currency">
          <Stats>
            <Stat value={money(sum(rows, "disputed_cents_activity"))} label="disputed" />
            <Stat value={money(lostCents)} label="lost" />
            <Stat value={money(wonCents)} label="won (recovered)" />
            <Stat value={(sum(rows, "dispute_fees_cents") / 100).toFixed(2)} label="dispute fees" />
          </Stats>
        </Panel>
        <Panel title="Early fraud warnings" note={`${months} months`}>
          <Stats>
            <Stat value={String(sum(rows, "efw"))} label="early fraud warnings" />
            <Stat value={money(sum(rows, "efw_cents"))} label="amount" />
            <Stat value={String(sum(rows, "efw_refunded"))} label="refunded" />
            <Stat value={String(sum(rows, "efw_became_disputes"))} label="became disputes" />
          </Stats>
        </Panel>
      </div>

      <div className="grid grid-cols-3 items-start gap-4 max-[1000px]:grid-cols-1">
        <Breakdown title="By method" data={data.by_method} />
        <Breakdown title="By flow" data={data.by_flow} />
        <Breakdown title="By country" data={data.by_country} />
      </div>

      <details className="group overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Monthly table</summary>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              {["Charges", "Disputes", "By payment", "Activity", "Won", "Lost", "Accepted", "Countered", "Disputed", "Lost $", "Won $", "Fees", "EFW", "EFW $", "EFW refunded", "EFW → dispute"].map((h) => (
                <TableHead key={h} numeric>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.month}>
                <TableCell>{r.month}</TableCell>
                <TableCell numeric>{r.charges}</TableCell>
                <TableCell numeric>{r.disputes_activity}</TableCell>
                <TableCell numeric>{r.disputes_by_payment}</TableCell>
                <TableCell numeric className={cn(r.activity_pct >= ref && "text-destructive")}>{pct(r.activity_pct)}</TableCell>
                <TableCell numeric>{r.won}</TableCell>
                <TableCell numeric>{r.lost}</TableCell>
                <TableCell numeric>{r.accepted}</TableCell>
                <TableCell numeric>{r.countered}</TableCell>
                <TableCell numeric>{money(r.disputed_cents_activity)}</TableCell>
                <TableCell numeric>{money(r.lost_cents)}</TableCell>
                <TableCell numeric>{money(r.won_cents ?? 0)}</TableCell>
                <TableCell numeric>{(r.dispute_fees_cents / 100).toFixed(2)}</TableCell>
                <TableCell numeric>{r.efw}</TableCell>
                <TableCell numeric>{money(r.efw_cents)}</TableCell>
                <TableCell numeric>{r.efw_refunded}</TableCell>
                <TableCell numeric>{r.efw_became_disputes}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </details>

      <p className="text-xs text-muted-foreground">
        {data.scope}. Denominator: {data.denominator}. Visa also counts early fraud warnings and can act below{" "}
        {pct(ref)}. Generated {dateTime(data.generated_at)}.
      </p>
    </>
  );
}

const TWO = "grid grid-cols-2 items-start gap-4 max-[1000px]:grid-cols-1";

/** Every open early fraud warning (GET /v1/admin/efws), newest first. */
function EfwList() {
  const { state, retry } = useQuery(efwsQuery, null);
  if (state.kind === "loading")
    return (
      <div className="px-4 py-3" aria-busy="true" aria-label="Loading">
        <Skeleton />
      </div>
    );
  if (state.kind === "error")
    return (
      <EmptyRow>
        Couldn't load the open warnings.{" "}
        <Button type="button" size="sm" variant="outline" onClick={retry}>
          Retry
        </Button>
      </EmptyRow>
    );
  if (state.data.length === 0) return <EmptyRow>No open early fraud warnings.</EmptyRow>;
  return (
    <ul className="list-none" data-testid="open-efws">
      {state.data.map((e) => (
        <li key={e.id} className="flex flex-col gap-1 border-b border-border-soft px-3.5 py-2.75 last:border-b-0">
          <span className="flex justify-between gap-2">
            <span className="text-sm font-medium">
              {e.case_id ? (
                <Link className="font-mono text-link hover:underline" to={paths.case(e.case_id)}>{e.case_id}</Link>
              ) : (
                "Fraud-warning hold, no case"
              )}
            </span>
            <span className="font-mono text-sm tabular-nums">{typeof e.amount_cents === "number" ? money(e.amount_cents) : "—"}</span>
          </span>
          <span className="flex justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate font-mono">{e.charge || e.payment_intent || e.id}</span>
            <span className="flex shrink-0 gap-2">
              {e.uid && <Link className="text-link hover:underline" to={paths.account(e.uid)}>Account</Link>}
              <span className="tabular-nums">{e.created ? dateOnly(e.created) : ""}</span>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const TONE_TEXT = { red: "text-destructive-foreground", amber: "text-warning-foreground", grey: "text-neutral-foreground" } as const;

/**
 * The current month's dispute rate against the card networks' line (B):
 * the number, a bar as a share of the line, and the last six months.
 * Amber from two thirds of the line, red at the line.
 */
function RateHero({ rows, reference }: { rows: DisputeMonth[]; reference: number }) {
  const cur = rows.at(-1);
  if (!cur) return null;
  const tone = (v: number) => (v >= reference ? "red" : v >= (reference * 2) / 3 ? "amber" : "grey");
  const share = Math.min(1, cur.activity_pct / reference);
  const t = tone(cur.activity_pct);
  return (
    <section aria-label="Dispute rate" className="flex flex-wrap items-center gap-6 rounded-xl border border-border bg-card p-4">
      <div className="flex w-55 flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">{monthLabel(cur.month)} dispute rate</span>
        <span className="font-mono text-[40px] leading-none tabular-nums" data-testid="current-rate">{pct(cur.activity_pct)}</span>
        <span className={cn("text-xs tabular-nums", t === "red" ? "text-destructive-foreground" : t === "amber" ? "text-warning-foreground" : "text-success-foreground")}>
          {cur.activity_pct >= reference ? "At or over" : "Under"} the {pct(reference)} line · {cur.disputes_activity} of {cur.charges}
        </span>
      </div>
      <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-2">
        <div
          role="img"
          aria-label={`Rate as a share of the ${pct(reference)} line: ${Math.round(share * 100)} percent`}
          className="h-3.5 overflow-hidden rounded-full bg-secondary"
        >
          {/* the width goes through React's style prop (CSSOM), which the CSP allows */}
          <div className={cn("h-full", t === "red" ? "bg-destructive" : "bg-warning")} style={{ width: `${share * 100}%` }} />
        </div>
        <div className="flex justify-between font-mono text-xs text-muted-foreground tabular-nums">
          <span>0%</span>
          <span className="text-destructive-foreground">{pct(reference)} line</span>
        </div>
        <ol className="mt-1.5 grid list-none grid-cols-6 gap-2 max-sm:grid-cols-3" aria-label="Last six months">
          {rows.slice(-6).map((r) => (
            <li key={r.month} className="flex flex-col gap-0.5 rounded-md bg-secondary px-2 py-1.5">
              <span className="text-2xs text-muted-foreground">{monthLabel(r.month)}</span>
              <span className={cn("font-mono text-sm tabular-nums", { red: "text-destructive-foreground", amber: "text-warning-foreground", grey: "text-foreground" }[tone(r.activity_pct)])}>
                {pct(r.activity_pct)}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Stats({ children, card = false }: { children: ReactNode; card?: boolean }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] [&>*]:border-r [&>*]:border-border [&>*:last-child]:border-r-0",
        card && "overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10",
      )}
    >
      {children}
    </div>
  );
}

function Stat({ value, label, sub, tone, info }: { value: string; label: string; sub?: string; tone?: "red"; info?: ReactNode }) {
  return (
    <div className="p-4">
      <div className={cn("text-2xl font-semibold tracking-tight tabular-nums", tone === "red" && "text-destructive")}>{value}</div>
      <div className="flex items-center gap-1.5 text-sm text-foreground-2">
        {label}
        {info && (
          <Popover>
            <PopoverTrigger
              aria-label={`About ${label}`}
              className="inline-flex size-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              ?
            </PopoverTrigger>
            <PopoverContent align="start">{info}</PopoverContent>
          </Popover>
        )}
      </div>
      {sub && <div className="text-2xs text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  );
}

const W = 560;
const H = 220;
const PAD = { l: 44, r: 8, t: 16, b: 26 };

function ActivityChart({ rows, reference }: { rows: DisputeMonth[]; reference: number }) {
  if (rows.length === 0) return <EmptyRow>No data.</EmptyRow>;
  const top = Math.max(reference * 4 / 3, ...rows.map((r) => r.activity_pct * 1.1), 0.0001);
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bw = iw / rows.length;
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const ticks = [0, top / 4, top / 2, (3 * top) / 4, top];
  const now = new Date();
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Monthly dispute activity against the ${pct(reference)} line`}>
      {ticks.map((t) => (
        <g key={t}>
          <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
          <text className="axis" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{pct(t)}</text>
        </g>
      ))}
      {rows.map((r, i) => {
        const h = Math.max(0, PAD.t + ih - y(r.activity_pct));
        const partial = r.month === thisMonth;
        return (
          <g key={r.month}>
            <rect
              className={`bar ${r.activity_pct >= reference ? "over" : ""} ${partial ? "partial" : ""}`}
              x={PAD.l + i * bw + bw * 0.2}
              y={y(r.activity_pct)}
              width={bw * 0.6}
              height={h}
              rx={2}
            >
              <title>{`${r.month}: ${pct(r.activity_pct)} (${r.disputes_activity} of ${r.charges})`}</title>
            </rect>
            <text className="axis" x={PAD.l + i * bw + bw / 2} y={H - 8} textAnchor="middle">
              {monthLabel(r.month)}{partial ? "*" : ""}
            </text>
          </g>
        );
      })}
      <line className="refline" x1={PAD.l} x2={W - PAD.r} y1={y(reference)} y2={y(reference)} data-testid="refline" />
      <text className="reflabel" x={PAD.l + 6} y={y(reference) - 5}>{pct(reference)} excessive</text>
    </svg>
  );
}

function OutcomeChart({ rows }: { rows: DisputeMonth[] }) {
  if (rows.length === 0) return <EmptyRow>No data.</EmptyRow>;
  const top = Math.max(1, ...rows.map((r) => r.disputes_activity));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bw = iw / rows.length;
  const unit = ih / top;
  const step = Math.max(1, Math.ceil(top / 4));
  const ticks: number[] = [];
  for (let t = 0; t <= top; t += step) ticks.push(t);
  return (
    <>
      <div className="flex gap-3.5 px-4 pt-2 text-xs text-foreground-2">
        <span><i className="mr-1.5 inline-block size-2.25 rounded-[2px] bg-chart-1" />Won</span>
        <span><i className="mr-1.5 inline-block size-2.25 rounded-[2px] bg-chart-2" />Lost</span>
        <span><i className="mr-1.5 inline-block size-2.25 rounded-[2px] bg-chart-3" />Open or pending</span>
      </div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Disputes per month by outcome">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih - t * unit} y2={PAD.t + ih - t * unit} />
            <text className="axis" x={PAD.l - 6} y={PAD.t + ih - t * unit + 4} textAnchor="end">{t}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const pending = Math.max(0, r.disputes_activity - r.won - r.lost);
          const segs: [string, number][] = [["won", r.won], ["lost", r.lost], ["open", pending]];
          let base = PAD.t + ih;
          return (
            <g key={r.month}>
              {segs.map(([cls, v]) => {
                if (!v) return null;
                const h = v * unit;
                base -= h;
                return (
                  <rect key={cls} className={`seg ${cls}`} x={PAD.l + i * bw + bw * 0.2} y={base} width={bw * 0.6} height={Math.max(0, h - 1)}>
                    <title>{`${r.month}: ${v} ${cls}`}</title>
                  </rect>
                );
              })}
              <text className="axis" x={PAD.l + i * bw + bw / 2} y={H - 8} textAnchor="middle">{monthLabel(r.month)}</text>
            </g>
          );
        })}
      </svg>
    </>
  );
}

function Breakdown({ title, data }: { title: string; data: Record<string, number> | null }) {
  const entries = Object.entries(data ?? {}).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const top = entries[0]?.[1] ?? 0;
  return (
    <Panel title={title} note="disputes · share">
      {entries.length === 0 ? (
        <EmptyRow>No disputes.</EmptyRow>
      ) : (
        <MiniTable>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td>{words(k)}</td>
              <td className="text-right font-mono tabular-nums">{v}</td>
              <td className="text-right font-mono tabular-nums">{pct(total ? v / total : 0, 0)}</td>
              <td className="barcell w-2/5">
                <svg viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" className="block h-1.5 w-full">
                  <rect className="bar" x="0" y="0" height="6" width={top ? (v / top) * 100 : 0} rx="1" />
                </svg>
              </td>
            </tr>
          ))}
        </MiniTable>
      )}
    </Panel>
  );
}
