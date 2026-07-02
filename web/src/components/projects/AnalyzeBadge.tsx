/**
 * Analyze-state badge for a project card. running = pulsing dot,
 * succeeded = quiet check, failed = red with the (user-safe) error.
 */

import type { AnalyzeInfo } from "@/lib/api/types";

export function AnalyzeBadge({ analyze }: { analyze: AnalyzeInfo }) {
  if (analyze.state === "running") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-edge bg-surface-1 px-2 py-0.5 text-xs text-fg-muted">
        <span
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
          aria-hidden
        />
        Analyzing
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
