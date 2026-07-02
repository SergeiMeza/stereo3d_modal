/**
 * Analyze-state badge for a project card. running = pulsing dot plus a live
 * progress readout (stage label, percent, thin bar, "~Xs left") when the
 * gateway sends progress/stage/eta, succeeded = quiet check, failed = red
 * with the (user-safe) error. The stage/eta helpers are shared with the
 * workspace's analyzing waiting states so every surface humanizes the
 * gateway's stage ids the same way.
 */

import type { JSX } from "react";

import { Progress } from "@/components/ui/progress";
import type { AnalyzeInfo } from "@/lib/api/types";

/** Gateway analyze stage ids → human labels. Unknown ids fall back to the
 * generic "Analyzing" rather than leaking internals. */
const STAGE_LABELS: Record<string, string> = {
  analyze: "Analyzing",
  proxy: "Building preview",
  scene_detect: "Detecting scenes",
  thumbnails: "Thumbnails",
  profiling: "Profiling shots",
};

export function analyzeStageLabel(stage?: string): string {
  return (stage !== undefined ? STAGE_LABELS[stage] : undefined) ?? "Analyzing";
}

/** "~42s left" / "~3m left" — compact remaining-time hint. */
export function formatEtaLeft(seconds: number): string {
  if (seconds < 90) return `~${Math.round(seconds)}s left`;
  return `~${Math.round(seconds / 60)}m left`;
}

/** The progress-ish subset shared by AnalyzeInfo and ProfileJobInfo — the
 * profile job reuses the same readout. */
export type ProgressLike = Pick<AnalyzeInfo, "progress" | "stage" | "eta_seconds">;

/** 0..1 progress → whole percent, clamped; null when absent. */
export function analyzePercent(analyze: ProgressLike): number | null {
  if (analyze.progress === undefined) return null;
  return Math.round(Math.min(Math.max(analyze.progress, 0), 1) * 100);
}

/** The live readout shared by the workspace waiting states (and the free
 * shot-profiling job): stage label, percent, thin progress bar, and the eta
 * when the gateway sends one. */
export function AnalyzeProgress({
  analyze,
}: {
  analyze: ProgressLike;
}): JSX.Element {
  const pct = analyzePercent(analyze);
  return (
    <div data-testid="analyze-progress" className="min-w-0 flex-1">
      <p className="flex flex-wrap items-baseline gap-x-2 font-medium text-fg">
        {analyzeStageLabel(analyze.stage)}…
        {pct !== null ? <span className="font-mono text-xs">{pct}%</span> : null}
        {analyze.eta_seconds !== undefined && analyze.eta_seconds > 0 ? (
          <span className="text-xs font-normal text-fg-muted">
            {formatEtaLeft(analyze.eta_seconds)}
          </span>
        ) : null}
      </p>
      {pct !== null ? (
        <Progress
          value={pct}
          aria-label="Analyze progress"
          className="mt-2 h-1 max-w-md"
        />
      ) : null}
    </div>
  );
}

export function AnalyzeBadge({ analyze }: { analyze: AnalyzeInfo }) {
  if (analyze.state === "running") {
    const pct = analyzePercent(analyze);
    return (
      <span
        data-testid="analyze-badge-running"
        className="inline-flex shrink-0 flex-col gap-1 rounded-md border border-edge bg-surface-1 px-2 py-0.5 text-xs text-fg-muted"
      >
        <span className="flex items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
            aria-hidden
          />
          {analyzeStageLabel(analyze.stage)}
          {pct !== null ? <span className="font-mono">{pct}%</span> : null}
          {analyze.eta_seconds !== undefined && analyze.eta_seconds > 0 ? (
            <span>{formatEtaLeft(analyze.eta_seconds)}</span>
          ) : null}
        </span>
        {pct !== null ? (
          <Progress
            value={pct}
            aria-label="Analyze progress"
            className="h-0.5 w-24"
          />
        ) : null}
      </span>
    );
  }
  if (analyze.state === "failed") {
    return (
      <span className="inline-flex max-w-full shrink items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" aria-hidden />
        <span className="truncate">
          Analyze failed{analyze.error ? ` — ${analyze.error}` : ""}
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-edge bg-surface-1 px-2 py-0.5 text-xs text-fg-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
      Analyzed
    </span>
  );
}
