import type { ReactNode } from "react";

import { Chip, ExtLink } from "../components/ui";
import { dateOnly, dateTime, money, time, words } from "../lib/format";
import { stripeLinkLabel } from "../lib/links";
import { Link, paths } from "../lib/router";
import type { Evidence, EvidenceRun } from "../lib/types";

function Section({
  title,
  aside,
  open = true,
  children,
}: {
  title: string;
  aside?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="ev" open={open}>
      <summary>
        <span className="chev" aria-hidden="true">›</span>
        <b>{title}</b>
        {aside !== undefined && <span className="muted xs right">{aside}</span>}
      </summary>
      <div className="evb">{children}</div>
    </details>
  );
}

function RunTimeline({ run }: { run: EvidenceRun }) {
  const steps: { at?: string | null; text: ReactNode; tone?: "ok" | "bad" }[] = [
    {
      at: run.created_at,
      text: (
        <>
          Created · {[run.step, run.preset, run.method].filter(Boolean).join(" · ")}
          {run.parts ? ` · ${run.parts} parts` : ""}
        </>
      ),
    },
  ];
  if (run.captured_cents) {
    steps.push({
      at: run.created_at,
      text: (
        <>
          Paid <b>{money(run.captured_cents)}</b>
          {run.payment_flow ? ` · ${words(run.payment_flow)}` : ""}
          {run.pi_status ? ` · ${words(run.pi_status)}` : ""}
        </>
      ),
    });
  } else if (run.quote_cents) {
    steps.push({ at: run.created_at, text: <>Quoted {money(run.quote_cents)}{run.payment_flow ? ` · ${words(run.payment_flow)}` : ""}</> });
  }
  if (run.submitted_at) steps.push({ at: run.submitted_at, text: `Queued${run.queued_s ? ` · waited ${Math.round(run.queued_s)} s` : ""}` });
  if (run.started_at) steps.push({ at: run.started_at, text: "Started" });
  if (run.error) {
    steps.push({
      at: run.updated_at,
      tone: "bad",
      text: (
        <>
          Failed · <span className="mono">{run.error.code}</span>
          {run.error.message ? ` · ${run.error.message}` : ""}
        </>
      ),
    });
  }
  if (run.canceled_by) steps.push({ at: run.updated_at, text: `Cancelled by ${run.canceled_by}` });
  steps.push({
    at: run.updated_at,
    tone: run.state === "SUCCEEDED" ? "ok" : undefined,
    text: <>Last state · {words(run.state)}{run.refunded_cents ? ` · refunded ${money(run.refunded_cents)}` : ""}</>,
  });
  return (
    <ol className="rtl">
      {steps.map((s, i) => (
        <li key={i} className={s.tone ?? ""}>
          <span className="t">{i === 0 ? dateTime(s.at) : time(s.at)}</span>
          {s.text}
        </li>
      ))}
      {run.error?.internal && (
        <li className="bad">
          <span className="t">internal</span>
          <span className="plain inline">{run.error.internal}</span>
        </li>
      )}
    </ol>
  );
}

/** M7: the latest frozen evidence snapshot, one collapsible section per source. */
export function EvidencePanel({ evidence, n }: { evidence: Evidence | null; n: number }) {
  if (!evidence) {
    return (
      <section className="card">
        <div className="sh"><b>Evidence</b></div>
        <p className="muted small pad">No snapshot yet. Use Refresh evidence.</p>
      </section>
    );
  }
  const runs = evidence.runs ?? [];
  const payments = evidence.payments ?? [];
  const refunds = evidence.refunds ?? [];
  const cases = evidence.cases ?? [];
  const links = evidence.links ?? {};
  const downloads = evidence.downloads;
  const gpuTotal = runs.reduce((s, r) => s + (r.gpu_cost_usd ?? 0), 0);
  const files = runs.flatMap((r) => (r.files_delivered ?? []).map((f) => ({ run: r.conversion_id, file: f })));

  return (
    <section className="card">
      <div className="sh">
        <b>Evidence</b>
        <span className="xs muted">
          Snapshot {evidence.n ?? n} · {dateTime(evidence.built_at)}
        </span>
      </div>

      {runs.map((r) => (
        <Section key={r.conversion_id} title="Run timeline" aside={<span className="mono">{r.conversion_id}</span>}>
          <RunTimeline run={r} />
        </Section>
      ))}
      {runs.length === 0 && (
        <Section title="Run timeline" aside="none">
          <p className="muted xs">No runs on this case.</p>
        </Section>
      )}

      <Section title="GPU work" aside={`$${gpuTotal.toFixed(2)} total`}>
        {runs.length === 0 ? (
          <p className="muted xs">No GPU work.</p>
        ) : (
          <table className="mini">
            <thead>
              <tr><th>Run</th><th>Job</th><th className="num">Waited</th><th className="num">Our cost</th><th>State</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.conversion_id}>
                  <td className="mono">{r.conversion_id}</td>
                  <td className="mono">{r.job_id || "—"}</td>
                  <td className="num">{r.queued_s ? `${Math.round(r.queued_s)} s` : "—"}</td>
                  <td className="num">${(r.gpu_cost_usd ?? 0).toFixed(2)}</td>
                  <td className={r.error ? "red" : ""}>{words(r.state)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section
        title="Files delivered"
        aside={runs.some((r) => r.parts) ? `${files.length} of ${runs.reduce((s, r) => s + (r.parts ?? 0), 0)} parts` : `${files.length} files`}
      >
        {files.length === 0 ? (
          <p className="muted xs">No files delivered.</p>
        ) : (
          <table className="mini">
            <thead><tr><th>File</th><th>Run</th></tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.run + f.file}>
                  <td className="mono">{f.file}</td>
                  <td className="mono muted">{f.run}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Downloads and plays" aside={Array.isArray(downloads) ? `${downloads.length} events` : "not recorded"}>
        {Array.isArray(downloads) ? (
          downloads.length === 0 ? (
            <p className="muted xs">No downloads or plays.</p>
          ) : (
            <table className="mini">
              <thead><tr><th>When</th><th>File</th><th>Kind</th><th>Country</th><th>Device</th></tr></thead>
              <tbody>
                {downloads.map((d, i) => (
                  <tr key={i}>
                    <td>{dateTime(d.at)}</td>
                    <td className="mono">{d.file}</td>
                    <td>{d.kind}</td>
                    <td>{d.ip_country}</td>
                    <td className="wrap">{d.user_agent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <p className="muted xs">{typeof downloads === "string" ? downloads : "Not recorded."}</p>
        )}
      </Section>

      <Section title="Payments" open={false} aside={`${payments.length} charges`}>
        {payments.length === 0 ? (
          <p className="muted xs">No charges.</p>
        ) : (
          <table className="mini">
            <thead><tr><th>Date</th><th>Kind</th><th className="num">Amount</th><th>PaymentIntent</th><th>Invoice</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.charge_id}>
                  <td>{dateOnly(p.paid_at)}</td>
                  <td>{words(p.kind)}</td>
                  <td className="num">{money(p.amount_cents)}</td>
                  <td className="mono">{p.payment_intent || "—"}</td>
                  <td>{words(p.invoice_state) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {refunds.length > 0 && (
          <table className="mini">
            <thead><tr><th>Refund</th><th>Case</th><th className="num">Amount</th><th>Status</th><th>Source</th><th>Date</th></tr></thead>
            <tbody>
              {refunds.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.re_id || r.id}</td>
                  <td><Link className="link mono" to={paths.case(r.case_id)}>{r.case_id}</Link></td>
                  <td className="num">{money(r.total_cents)}</td>
                  <td>{words(r.status)}</td>
                  <td>{r.source}</td>
                  <td>{dateOnly(r.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Previous cases" open={false} aside={cases.length ? `${cases.length}` : "none"}>
        {cases.length === 0 ? (
          <p className="muted xs">No earlier cases.</p>
        ) : (
          <table className="mini">
            <thead><tr><th>Case</th><th>Type</th><th>Decision</th><th className="num">Amount</th><th>Opened</th></tr></thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td><Link className="link mono" to={paths.case(c.id)}>{c.id}</Link></td>
                  <td>{words(c.type)} · {words(c.reason)}</td>
                  <td>{words(c.decision ?? c.result ?? c.status)}</td>
                  <td className="num">{money(c.decided_cents)}</td>
                  <td>{dateOnly(c.opened_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Links">
        <div className="lk">
          {links.logs_url && <ExtLink href={links.logs_url}>Gateway logs</ExtLink>}
          {(links.stripe_urls ?? []).map((u) => (
            <ExtLink key={u} href={u}>{stripeLinkLabel(u)}</ExtLink>
          ))}
          {(links.modal_urls ?? []).map((u, i) => (
            <ExtLink key={u} href={u}>GPU job {i + 1}</ExtLink>
          ))}
        </div>
        {(links.modal_job_ids ?? []).length > 0 && (
          <p className="xs muted">
            GPU job IDs: <span className="mono">{(links.modal_job_ids ?? []).join(", ")}</span>
          </p>
        )}
      </Section>
    </section>
  );
}

export function deliveredChip(delivered: string, run?: EvidenceRun) {
  if (delivered === "yes") return <Chip tone="green">Yes</Chip>;
  if (delivered === "partly") {
    const of = run?.parts ? ` · ${Math.min(run.files_delivered?.length ?? 0, run.parts)} of ${run.parts}` : "";
    return <Chip tone="amber">Partly{of}</Chip>;
  }
  return <Chip tone="muted">No</Chip>;
}
