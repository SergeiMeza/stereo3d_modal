import type { ReactNode } from "react";

import { ExtLink, MiniTable, Panel } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { dateOnly, dateTime, money, time, words } from "../lib/format";
import { stripeLinkLabel } from "../lib/links";
import { Link, paths } from "../lib/router";
import { audioLine, commercialLine, depthLine, fileQualityLine, stabilizeLine } from "../lib/fileQuality";
import { sourceOf, sourceRows } from "../lib/sourceDetails";
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
    <details className="group border-b border-border last:border-b-0" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
        <span className="inline-block w-2.5 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true">
          ›
        </span>
        <b className="font-medium">{title}</b>
        {aside !== undefined && <span className="ml-auto text-xs text-muted-foreground">{aside}</span>}
      </summary>
      <div className="flex flex-col gap-2 overflow-x-auto pr-4 pb-3 pl-8.5 [&>div]:px-0">{children}</div>
    </details>
  );
}

const STEP_T = "inline-block min-w-24 font-mono text-xs text-muted-foreground";

function stepCls(tone?: "ok" | "bad") {
  return cn(
    "relative pl-3.5 text-sm text-foreground-2 before:absolute before:top-1.5 before:-left-[4.5px] before:size-2 before:rounded-full before:bg-neutral",
    tone === "ok" && "before:bg-success",
    tone === "bad" && "text-destructive-foreground before:bg-destructive",
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
  // owner 2026-11-07: the launch offer the run had (gateway 00175)
  if ((run.campaign_cents ?? 0) > 0) {
    steps.push({
      at: run.created_at,
      text: <span data-testid="run-campaign">Launch offer −{money(run.campaign_cents)}</span>,
    });
  }
  // owner 2026-11-09: the Commercial use add-on (bought, plan-included or not)
  const commercial = commercialLine(run);
  if (commercial) {
    steps.push({
      at: run.created_at,
      text: <span data-testid="run-commercial">Commercial use: {commercial}</span>,
    });
  }
  // owner 2026-11-10: Smoother motion and the 3D depth (Lifelike runs)
  const stabilize = stabilizeLine(run);
  if (stabilize) {
    steps.push({
      at: run.created_at,
      text: <span data-testid="run-stabilize">Smoother motion: {stabilize}</span>,
    });
  }
  const depth = depthLine(run);
  if (depth) {
    steps.push({
      at: run.created_at,
      text: <span data-testid="run-depth">3D depth: {depth}</span>,
    });
  }
  // owner 2026-11-07: the File quality asked for, with what the files measure
  const quality = fileQualityLine(run);
  const audio = audioLine(run);
  if (quality || audio) {
    steps.push({
      at: run.created_at,
      text: (
        <span data-testid="run-quality">
          {quality ? <>Quality: {quality}</> : null}
          {quality && audio ? " · " : null}
          {audio ? <>Audio: {audio}</> : null}
        </span>
      ),
    });
  }
  if (run.submitted_at) steps.push({ at: run.submitted_at, text: `Queued${run.queued_s ? ` · waited ${Math.round(run.queued_s)} s` : ""}` });
  if (run.started_at) steps.push({ at: run.started_at, text: "Started" });
  if (run.error) {
    steps.push({
      at: run.updated_at,
      tone: "bad",
      text: (
        <>
          Failed · <span className="font-mono">{run.error.code}</span>
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
    <ol className="flex list-none flex-col gap-1.5 border-l border-border py-0 pr-0 pl-1">
      {steps.map((s, i) => (
        <li key={i} className={stepCls(s.tone)}>
          <span className={STEP_T}>{i === 0 ? dateTime(s.at) : time(s.at)}</span>
          {s.text}
        </li>
      ))}
      {run.error?.internal && (
        <li className={stepCls("bad")}>
          <span className={STEP_T}>internal</span>
          <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{run.error.internal}</span>
        </li>
      )}
    </ol>
  );
}

/** M7: the latest frozen evidence snapshot, one collapsible section per source. */
export function EvidencePanel({ evidence, n }: { evidence: Evidence | null; n: number }) {
  if (!evidence) {
    return (
      <Panel title="Evidence">
        <p className="px-4 py-3 text-sm text-muted-foreground">No snapshot yet. Use Refresh evidence.</p>
      </Panel>
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
    <Panel title="Evidence" note={`Snapshot ${evidence.n ?? n} · ${dateTime(evidence.built_at)}`}>

      {runs.map((r) => (
        <Section key={r.conversion_id} title="Run timeline" aside={<span className="font-mono">{r.conversion_id}</span>}>
          <RunTimeline run={r} />
        </Section>
      ))}
      {runs.map((r) => {
        // owner 2026-11-07: the run's source video, as the web's Overview shows it
        const src = sourceOf(r);
        const rows = src ? sourceRows(src) : [];
        return rows.length > 0 ? (
          <Section key={`src-${r.conversion_id}`} title="Source" open={false} aside={<span className="font-mono">{r.conversion_id}</span>}>
            <dl data-testid="run-source" className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
              {rows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="min-w-0 break-words">{row.value}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ) : null;
      })}
      {runs.length === 0 && (
        <Section title="Run timeline" aside="none">
          <p className="text-xs text-muted-foreground">No runs on this case.</p>
        </Section>
      )}

      <Section title="GPU work" aside={`$${gpuTotal.toFixed(2)} total`}>
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No GPU work.</p>
        ) : (
          <MiniTable head={<tr><th>Run</th><th>Job</th><th className="text-right font-mono tabular-nums">Waited</th><th className="text-right font-mono tabular-nums">Our cost</th><th>State</th></tr>}>
              {runs.map((r) => (
                <tr key={r.conversion_id}>
                  <td className="font-mono">{r.conversion_id}</td>
                  <td className="font-mono">{r.job_id || "—"}</td>
                  <td className="text-right font-mono tabular-nums">{r.queued_s ? `${Math.round(r.queued_s)} s` : "—"}</td>
                  <td className="text-right font-mono tabular-nums">${(r.gpu_cost_usd ?? 0).toFixed(2)}</td>
                  <td className={r.error ? "text-destructive" : ""}>{words(r.state)}</td>
                </tr>
              ))}
            </MiniTable>
        )}
      </Section>

      <Section
        title="Files delivered"
        aside={runs.some((r) => r.parts) ? `${files.length} of ${runs.reduce((s, r) => s + (r.parts ?? 0), 0)} parts` : `${files.length} files`}
      >
        {files.length === 0 ? (
          <p className="text-xs text-muted-foreground">No files delivered.</p>
        ) : (
          <MiniTable head={<tr><th>File</th><th>Run</th></tr>}>
              {files.map((f) => (
                <tr key={f.run + f.file}>
                  <td className="font-mono">{f.file}</td>
                  <td className="font-mono text-muted-foreground">{f.run}</td>
                </tr>
              ))}
            </MiniTable>
        )}
      </Section>

      <Section title="Downloads and plays" aside={Array.isArray(downloads) ? `${downloads.length} events` : "not recorded"}>
        {Array.isArray(downloads) ? (
          downloads.length === 0 ? (
            <p className="text-xs text-muted-foreground">No downloads or plays.</p>
          ) : (
            <MiniTable head={<tr><th>When</th><th>File</th><th>Kind</th><th>Country</th><th>Device</th></tr>}>
                {downloads.map((d, i) => (
                  <tr key={i}>
                    <td>{dateTime(d.at)}</td>
                    <td className="font-mono">{d.file}</td>
                    <td>{d.kind}</td>
                    <td>{d.ip_country}</td>
                    <td className="whitespace-normal">{d.user_agent}</td>
                  </tr>
                ))}
              </MiniTable>
          )
        ) : (
          <p className="text-xs text-muted-foreground">{typeof downloads === "string" ? downloads : "Not recorded."}</p>
        )}
      </Section>

      <Section title="Payments" open={false} aside={`${payments.length} charges`}>
        {payments.length === 0 ? (
          <p className="text-xs text-muted-foreground">No charges.</p>
        ) : (
          <MiniTable head={<tr><th>Date</th><th>Kind</th><th className="text-right font-mono tabular-nums">Amount</th><th>PaymentIntent</th><th>Invoice</th></tr>}>
              {payments.map((p) => (
                <tr key={p.charge_id}>
                  <td>{dateOnly(p.paid_at)}</td>
                  <td>{words(p.kind)}</td>
                  <td className="text-right font-mono tabular-nums">{money(p.amount_cents)}</td>
                  <td className="font-mono">{p.payment_intent || "—"}</td>
                  <td>{words(p.invoice_state) || "—"}</td>
                </tr>
              ))}
            </MiniTable>
        )}
        {refunds.length > 0 && (
          <MiniTable head={<tr><th>Refund</th><th>Case</th><th className="text-right font-mono tabular-nums">Amount</th><th>Status</th><th>Source</th><th>Date</th></tr>}>
              {refunds.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono">{r.re_id || r.id}</td>
                  <td><Link className="font-mono text-link hover:underline" to={paths.case(r.case_id)}>{r.case_id}</Link></td>
                  <td className="text-right font-mono tabular-nums">{money(r.total_cents)}</td>
                  <td>{words(r.status)}</td>
                  <td>{r.source}</td>
                  <td>{dateOnly(r.at)}</td>
                </tr>
              ))}
            </MiniTable>
        )}
      </Section>

      <Section title="Previous cases" open={false} aside={cases.length ? `${cases.length}` : "none"}>
        {cases.length === 0 ? (
          <p className="text-xs text-muted-foreground">No earlier cases.</p>
        ) : (
          <MiniTable head={<tr><th>Case</th><th>Type</th><th>Decision</th><th className="text-right font-mono tabular-nums">Amount</th><th>Opened</th></tr>}>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td><Link className="font-mono text-link hover:underline" to={paths.case(c.id)}>{c.id}</Link></td>
                  <td>{words(c.type)} · {words(c.reason)}</td>
                  <td>{words(c.decision ?? c.result ?? c.status)}</td>
                  <td className="text-right font-mono tabular-nums">{money(c.decided_cents)}</td>
                  <td>{dateOnly(c.opened_at)}</td>
                </tr>
              ))}
            </MiniTable>
        )}
      </Section>

      <Section title="Links">
        <div className="flex flex-wrap gap-4">
          {links.logs_url && <ExtLink href={links.logs_url}>Gateway logs</ExtLink>}
          {(links.stripe_urls ?? []).map((u) => (
            <ExtLink key={u} href={u}>{stripeLinkLabel(u)}</ExtLink>
          ))}
          {(links.modal_urls ?? []).map((u, i) => (
            <ExtLink key={u} href={u}>GPU job {i + 1}</ExtLink>
          ))}
        </div>
        {(links.modal_job_ids ?? []).length > 0 && (
          <p className="text-xs text-muted-foreground">
            GPU job IDs: <span className="font-mono">{(links.modal_job_ids ?? []).join(", ")}</span>
          </p>
        )}
      </Section>
    </Panel>
  );
}

export function deliveredChip(delivered: string, run?: EvidenceRun) {
  if (delivered === "yes") return <Badge variant="green">Yes</Badge>;
  if (delivered === "partly") {
    const of = run?.parts ? ` · ${Math.min(run.files_delivered?.length ?? 0, run.parts)} of ${run.parts}` : "";
    return <Badge variant="amber">Partly{of}</Badge>;
  }
  return <Badge variant="muted">No</Badge>;
}
