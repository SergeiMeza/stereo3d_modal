"use client";

/**
 * Files (screen 09, S3D-31/21/24/33): every run of the project, newest
 * first, as a card — what it is ("Full video", "Preview"), its method, a
 * short line (quality · moment · parts · date), its state in a word and
 * its price with a word only for Refunded, Not charged or Payment needed.
 * Finished runs list their files by device (RunFiles), with View in 3D.
 * Files stay downloadable after a failed payment (S3D-22). Deleting a
 * project happens only from the Archived view (owner 2026-11-04: archive
 * first, then delete). Each run has a Details toggle (RunDetails, owner
 * 2026-11-07) with what the gateway returned for it and its Run ID.
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
import { qualityLabelFor, runSummary, STEP_NAMES, stepName } from "@/lib/glossary";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

import { METHOD_LABELS } from "./methods";
import { formatCents } from "./money";
import { RunDetails } from "./RunDetails";
import { RunFiles } from "./RunFiles";
import { RunProgressCompact } from "./RunProgressCompact";
import { runStateShort } from "./runStatus";
import { ltrRuns } from "@/lib/i18n/bidi";

/** One-line settings summary for a run, in customer words. */
export function paramsSummary(c: Conversion, t: Tr = EN): string {
  return runSummary(c.params, c.step, c.foveation, t);
}

/** "1080p · 0:45 – 0:50 · 3 parts · Nov 2" */
export function runMeta(project: Project, c: Conversion, t: Tr = EN): string {
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
  return ltrRuns([
    range,
    c.step !== "depth_preview"
      ? qualityLabelFor(project, c.params.preset, t)
      : null,
    c.parts && c.parts.length > 1 ? t("files.history.parts", { count: c.parts.length }) : null,
    new Date(c.created_at).toLocaleDateString(t.intl, {
      month: "short",
      day: "numeric",
    }),
  ]
    .filter(Boolean)
    .join(" · "), t);
}

// by the English state word (runStateShort without a translator)
const CHIP: Record<string, string> = {
  Ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  Failed: "border-red-500/30 bg-red-500/10 text-red-300",
};

export function HistoryList({ project }: { project: Project }): JSX.Element {
  const t = useT();
  const conversions = [...(project.conversions ?? [])].sort((a, b) =>
    a.created_at < b.created_at ? 1 : -1,
  );
  // The page title lives in the shared PageHeader (WorkspaceScreen).
  return (
    <section aria-label={t("files.history.label")} className="flex flex-col gap-3">
      {conversions.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {t("files.history.empty")}
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
  const t = useT();
  const state = runStateShort(c, t);
  const chip = CHIP[runStateShort(c)];
  const word = paymentStatus(c, t);
  return (
    <li
      data-testid={`history-${c.conversion_id}`}
      data-conversion-id={c.conversion_id}
      className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-sm font-semibold text-fg">
          {STEP_NAMES[c.step ?? "production"] ? stepName(c.step ?? "production", t) : t("runs.tracker.runFallback")}
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
          {runMeta(project, c, t)}
        </span>
        <span className="ms-auto flex items-center gap-3">
          <span
            data-testid="run-status"
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              chip ?? "border-edge bg-surface-2 text-fg-muted"
            }`}
          >
            {state}
          </span>
          <span
            data-testid="history-price"
            className="font-mono text-sm text-fg-muted"
          >
            {formatCents(c.quote.amount_cents, t)}
            {word ? ` · ${word}` : ""}
            {/* owner 2026-11-07: the launch offer the run had */}
            {(c.campaign_cents ?? c.quote.breakdown?.campaign_cents ?? 0) > 0 ? (
              <span data-testid="history-offer" className="ms-1 text-xs text-emerald-300">
                {c.quote.breakdown?.campaign_label ?? t("files.history.launchOffer")}
              </span>
            ) : null}
          </span>
        </span>
      </div>
      {/* owner 2026-11-05: a running run says where it is */}
      {c.state === "created" || c.state === "paid" || c.state === "processing" ? (
        <RunProgressCompact conversion={c} chip={false} />
      ) : null}
      {/* S3D-24: once the files are erased the run stays, its files don't */}
      {c.state === "succeeded" && project.files_deleted_at === undefined ? (
        <RunFiles conversion={c} />
      ) : null}
      {c.state === "failed" ? (
        <p className="text-xs text-fg-muted">
          {t("files.history.failed")}
        </p>
      ) : null}
      <RunDetails project={project} conversion={c} />
    </li>
  );
}
