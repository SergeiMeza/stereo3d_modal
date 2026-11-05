"use client";

/**
 * Files (screen 09, S3D-31/21/24/33): every run of the project, newest
 * first, as a card — what it is ("Full video", "Preview"), its method, a
 * short line (quality · moment · parts · date), its state in a word and
 * its price with a word only for Refunded, Not charged or Payment needed.
 * Finished runs list their files by device (RunFiles), with View in 3D.
 * Files stay downloadable after a failed payment (S3D-22). Deleting a
 * project happens only from the Archived view (owner 2026-11-04: archive
 * first, then delete).
 */

import type { JSX } from "react";

import {
  conversionMethod,
  methodOf,
  type Conversion,
  type Project,
} from "@/lib/api/types";
import { paymentStatus } from "@/lib/billingCopy";
import { formatClock } from "@/lib/format";
import { frameToSeconds, parseRational } from "@/lib/frames";
import { qualityLabelFor, runSummary, STEP_NAMES } from "@/lib/glossary";

import { METHOD_LABELS } from "./methods";
import { formatCents } from "./money";
import { RunFiles } from "./RunFiles";
import { RunProgressCompact } from "./RunProgressCompact";
import { runStateShort } from "./runStatus";

/** One-line settings summary for a run, in customer words. */
export function paramsSummary(c: Conversion): string {
  return runSummary(c.params, c.step);
}

/** "1080p · 0:45 – 0:50 · 3 parts · Nov 2" */
export function runMeta(project: Project, c: Conversion): string {
  const fps = project.probe ? parseRational(project.probe.fps_rational) : null;
  const clock = (f: number) =>
    fps ? formatClock(frameToSeconds(f, fps)) : null;
  const preview = c.step !== "production";
  const range =
    preview &&
    fps &&
    c.params.from_frame !== undefined &&
    c.params.to_frame !== undefined
      ? `${clock(c.params.from_frame)} – ${clock(c.params.to_frame)}`
      : null;
  return [
    range,
    c.step !== "depth_preview"
      ? qualityLabelFor(project, c.params.preset)
      : null,
    c.parts && c.parts.length > 1 ? `${c.parts.length} parts` : null,
    new Date(c.created_at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
  ]
    .filter(Boolean)
    .join(" · ");
}

const CHIP: Record<string, string> = {
  Ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  Failed: "border-red-500/30 bg-red-500/10 text-red-300",
};

export function HistoryList({ project }: { project: Project }): JSX.Element {
  const conversions = [...(project.conversions ?? [])].sort((a, b) =>
    a.created_at < b.created_at ? 1 : -1,
  );
  // The page title lives in the shared PageHeader (WorkspaceScreen).
  return (
    <section aria-label="Conversion history" className="flex flex-col gap-3">
      {conversions.length === 0 ? (
        <p className="text-sm text-fg-muted">
          Nothing here yet. Your 3D files appear here when they&apos;re ready.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {conversions.map((c) => (
            <HistoryRow
              key={c.conversion_id}
              project={project}
              conversion={c}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryRow({
  project,
  conversion: c,
}: {
  project: Project;
  conversion: Conversion;
}): JSX.Element {
  const state = runStateShort(c);
  const word = paymentStatus(c);
  return (
    <li
      data-testid={`history-${c.conversion_id}`}
      data-conversion-id={c.conversion_id}
      className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-sm font-semibold text-fg">
          {STEP_NAMES[c.step ?? "production"] ?? "Run"}
        </span>
        {/* a Lifelike project never names Classic (S3D-01) */}
        {methodOf(project) === "classic" ? (
          <span
            data-testid="history-method"
            className="rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted"
          >
            {METHOD_LABELS[conversionMethod(c)]}
          </span>
        ) : null}
        <span data-testid="history-params" className="text-xs text-fg-muted">
          {runMeta(project, c)}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span
            data-testid="run-status"
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              CHIP[state] ?? "border-edge bg-surface-2 text-fg-muted"
            }`}
          >
            {state}
          </span>
          <span
            data-testid="history-price"
            className="font-mono text-sm text-fg-muted"
          >
            {formatCents(c.quote.amount_cents)}
            {word ? ` · ${word}` : ""}
          </span>
        </span>
      </div>
      {/* owner 2026-11-05: a running run says where it is */}
      {c.state === "created" || c.state === "paid" || c.state === "processing" ? (
        <RunProgressCompact conversion={c} poll chip={false} />
      ) : null}
      {/* S3D-24: once the files are erased the run stays, its files don't */}
      {c.state === "succeeded" && project.files_deleted_at === undefined ? (
        <RunFiles conversion={c} />
      ) : null}
      {c.state === "failed" ? (
        <p className="text-xs text-fg-muted">
          Something went wrong on our side.
        </p>
      ) : null}
    </li>
  );
}
