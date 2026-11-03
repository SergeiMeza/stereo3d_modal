import { useState } from "react";

import { Button, ErrorState, ExtLink, SkeletonRows } from "../components/ui";
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
      <div className="titlebar">
        <h1>Disputes and fraud</h1>
        <span className="muted small">Web app charges only · refreshed on load</span>
        <span className="grow" />
        <select className="fsel" aria-label="Months" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
          <option value={6}>Last 6 months</option>
          <option value={12}>Last 12 months</option>
          <option value={24}>Last 24 months</option>
        </select>
        <Button size="sm" onClick={() => void downloadCsv()} disabled={csvBusy}>
          {csvBusy ? "Working…" : "CSV"}
        </Button>
        {state.kind === "loaded" && <ExtLink href={state.data.account_wide}>Whole Stripe account</ExtLink>}
      </div>
      {csvErr && <p className="err small" role="alert">{csvErr}</p>}
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
      <div className="stats card">
        <Stat value={String(disputes)} label={`disputes, ${months} months`} sub="by dispute date" />
        <Stat value={pct(avg)} label="dispute activity" sub={`${months}-month average · line ${pct(ref)}`} tone={avg >= ref ? "red" : undefined} />
        <Stat value={pct(data.counter_rate, 0)} label="countered" sub={`${countered} of ${disputes}`} />
        <Stat value={pct(data.win_rate, 0)} label="won" sub={`${won} of ${won + lost} decided`} />
      </div>
      {over.length > 0 && (
        <p className="err small" role="alert">
          Over the {pct(ref)} line in {over.map((r) => monthLabel(r.month)).join(", ")}.
        </p>
      )}

      <div className="two even">
        <section className="card">
          <div className="sh"><b>Dispute activity by month</b><span className="xs muted">disputes ÷ successful charges</span></div>
          <ActivityChart rows={rows} reference={ref} />
        </section>
        <section className="card">
          <div className="sh"><b>Disputes by outcome</b><span className="xs muted">by dispute date</span></div>
          <OutcomeChart rows={rows} />
        </section>
      </div>

      <div className="two even">
        <section className="card">
          <div className="sh"><b>Money</b><span className="xs muted">fees in the account's currency</span></div>
          <div className="stats inner">
            <Stat value={money(sum(rows, "disputed_cents_activity"))} label="disputed" />
            <Stat value={money(sum(rows, "lost_cents"))} label="lost" />
            <Stat value={(sum(rows, "dispute_fees_cents") / 100).toFixed(2)} label="dispute fees" />
          </div>
        </section>
        <section className="card">
          <div className="sh"><b>Early fraud warnings</b><span className="xs muted">{months} months</span></div>
          <div className="stats inner">
            <Stat value={String(sum(rows, "efw"))} label="early fraud warnings" />
            <Stat value={money(sum(rows, "efw_cents"))} label="amount" />
            <Stat value={String(sum(rows, "efw_refunded"))} label="refunded" />
            <Stat value={String(sum(rows, "efw_became_disputes"))} label="became disputes" />
          </div>
        </section>
      </div>

      <section className="card">
        <div className="sh"><b>Open disputes</b><span className="xs muted">by evidence due date</span></div>
        {open.length === 0 ? (
          <p className="muted xs pad">No open disputes.</p>
        ) : (
          <div className="scroll-x">
            <table className="at">
              <thead>
                <tr><th>Case</th><th>Evidence due</th><th className="num">Amount</th><th>Reason</th><th>Status</th><th>Dispute</th></tr>
              </thead>
              <tbody>
                {open.map((d) => (
                  <tr key={d.dispute_id}>
                    <td>{d.case_id ? <Link className="cid mono" to={paths.case(d.case_id)}>{d.case_id}</Link> : <span className="muted">no case</span>}</td>
                    <td>
                      {d.due_by ? (
                        <>
                          {dateOnly(d.due_by)} <span className="muted xs">{until(d.due_by)}</span>
                        </>
                      ) : "—"}
                    </td>
                    <td className="num">{money(d.amount_cents)}</td>
                    <td>{words(d.reason)}</td>
                    <td>{words(d.status)}</td>
                    <td className="mono xs">{d.dispute_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid3">
        <Breakdown title="By method" data={data.by_method} />
        <Breakdown title="By flow" data={data.by_flow} />
        <Breakdown title="By country" data={data.by_country} />
      </div>

      <details className="card monthly">
        <summary><b>Monthly table</b></summary>
        <div className="scroll-x">
          <table className="at">
            <thead>
              <tr>
                <th>Month</th><th className="num">Charges</th><th className="num">Disputes</th><th className="num">By payment</th>
                <th className="num">Activity</th><th className="num">Won</th><th className="num">Lost</th><th className="num">Accepted</th>
                <th className="num">Countered</th><th className="num">Disputed</th><th className="num">Lost $</th><th className="num">Fees</th>
                <th className="num">EFW</th><th className="num">EFW $</th><th className="num">EFW refunded</th><th className="num">EFW → dispute</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.month}>
                  <td>{r.month}</td>
                  <td className="num">{r.charges}</td>
                  <td className="num">{r.disputes_activity}</td>
                  <td className="num">{r.disputes_by_payment}</td>
                  <td className={`num ${r.activity_pct >= ref ? "red" : ""}`}>{pct(r.activity_pct)}</td>
                  <td className="num">{r.won}</td>
                  <td className="num">{r.lost}</td>
                  <td className="num">{r.accepted}</td>
                  <td className="num">{r.countered}</td>
                  <td className="num">{money(r.disputed_cents_activity)}</td>
                  <td className="num">{money(r.lost_cents)}</td>
                  <td className="num">{(r.dispute_fees_cents / 100).toFixed(2)}</td>
                  <td className="num">{r.efw}</td>
                  <td className="num">{money(r.efw_cents)}</td>
                  <td className="num">{r.efw_refunded}</td>
                  <td className="num">{r.efw_became_disputes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <p className="muted xs">
        {data.scope}. Denominator: {data.denominator}. Visa also counts early fraud warnings and can act below{" "}
        {pct(ref)}. Generated {dateTime(data.generated_at)}.
      </p>
    </>
  );
}

function Stat({ value, label, sub, tone }: { value: string; label: string; sub?: string; tone?: "red" }) {
  return (
    <div className="stat">
      <div className={`stat-v ${tone ?? ""}`}>{value}</div>
      <div className="stat-l">{label}</div>
      {sub && <div className="stat-s">{sub}</div>}
    </div>
  );
}

const W = 560;
const H = 220;
const PAD = { l: 44, r: 8, t: 16, b: 26 };

function ActivityChart({ rows, reference }: { rows: DisputeMonth[]; reference: number }) {
  if (rows.length === 0) return <p className="muted xs pad">No data.</p>;
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
  if (rows.length === 0) return <p className="muted xs pad">No data.</p>;
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
      <div className="legend">
        <span><i className="sw won" />Won</span>
        <span><i className="sw lost" />Lost</span>
        <span><i className="sw open" />Open or pending</span>
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
    <section className="card">
      <div className="sh"><b>{title}</b><span className="xs muted">disputes · share</span></div>
      {entries.length === 0 ? (
        <p className="muted xs pad">No disputes.</p>
      ) : (
        <table className="mini pad-table">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <td>{words(k)}</td>
                <td className="num">{v}</td>
                <td className="num">{pct(total ? v / total : 0, 0)}</td>
                <td className="barcell">
                  <svg viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
                    <rect className="bar" x="0" y="0" height="6" width={top ? (v / top) * 100 : 0} rx="1" />
                  </svg>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
