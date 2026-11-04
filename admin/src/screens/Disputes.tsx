import { useState } from "react";

import type { ReactNode } from "react";

import { EmptyRow, ErrorState, ExtLink, FilterSelect, MiniTable, Note, PageHeader, Panel, SkeletonRows } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage } from "../lib/api";
import { dateOnly, dateTime, money, monthLabel, pct, until, words } from "../lib/format";
import { Link, paths } from "../lib/router";
import { useServices } from "../lib/services";
import type { DisputeMonth, DisputeSummary } from "../lib/types";
import { useLoad } from "../lib/useLoad";

/** A4: disputes and fraud (BL-11 monitoring). */
export function DisputesPanel() {
  const { api } = useServices();
  const [months, setMonths] = useState(12);
  const { state, retry } = useLoad(() => api.disputes(months), [api, months]);
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
              {csvBusy ? "Working…" : "CSV"}
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

  return (
    <>
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
            <Stat value={money(sum(rows, "lost_cents"))} label="lost" />
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

      <Panel title="Open disputes" note="by evidence due date">
        {open.length === 0 ? (
          <EmptyRow>No open disputes.</EmptyRow>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead><TableHead>Evidence due</TableHead><TableHead numeric>Amount</TableHead>
                <TableHead>Reason</TableHead><TableHead>Status</TableHead><TableHead>Dispute</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {open.map((d) => (
                <TableRow key={d.dispute_id}>
                  <TableCell>
                    {d.case_id ? (
                      <Link className="font-mono font-medium text-link" to={paths.case(d.case_id)}>{d.case_id}</Link>
                    ) : (
                      <span className="text-muted-foreground">no case</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {d.due_by ? (
                      <>
                        {dateOnly(d.due_by)} <span className="text-xs text-muted-foreground">{until(d.due_by)}</span>
                      </>
                    ) : "—"}
                  </TableCell>
                  <TableCell numeric>{money(d.amount_cents)}</TableCell>
                  <TableCell>{words(d.reason)}</TableCell>
                  <TableCell>{words(d.status)}</TableCell>
                  <TableCell className="font-mono text-xs">{d.dispute_id}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

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
              {["Charges", "Disputes", "By payment", "Activity", "Won", "Lost", "Accepted", "Countered", "Disputed", "Lost $", "Fees", "EFW", "EFW $", "EFW refunded", "EFW → dispute"].map((h) => (
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
