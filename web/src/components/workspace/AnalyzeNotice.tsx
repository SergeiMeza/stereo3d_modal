"use client";

/**
 * The analysis never just spins (owner bug 2026-11-05): once it has sat
 * still for 3 minutes or run for 10, "This is taking longer than usual."
 * with Refresh (the page keeps polling); a failed one says "We couldn't
 * analyze this video." with Try again and Contact support. Reads the
 * project's atom (ADR 0138).
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { supportMailto } from "@/components/billing/BillingBanner";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN } from "@/lib/i18n/t";

import { analyzeSlow, type ProjectState } from "./workspaceAtoms";

export const ANALYZE_SLOW = EN("workspace.analyze.slow");
export const ANALYZE_FAILED = EN("workspace.analyze.failed");

/** The clock, re-read every 15 s while `on`. */
function useClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function AnalyzeNotice({
  state,
  onRefresh,
  onRetry,
}: {
  state: ProjectState;
  onRefresh: () => void;
  onRetry: () => void;
}): JSX.Element | null {
  const t = useT();
  const project = state.project;
  const running = project?.analyze.state === "running";
  const now = useClock(running);
  if (!project || project.files_deleted_at !== undefined) return null;

  if (project.analyze.state === "failed") {
    return (
      <div
        role="alert"
        data-testid="analyze-failed"
        className="mb-4 flex flex-col gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-4 text-red-300"
      >
        <p className="font-medium">{t("workspace.analyze.failed")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={state.retrying} onClick={onRetry}>
            {state.retrying ? t("workspace.analyze.retrying") : t("workspace.analyze.retry")}
          </Button>
          <a
            href={supportMailto(`Video analysis · project ${project.project_id}`)}
            className="text-sm text-red-200 underline underline-offset-2 hover:text-red-100"
          >
            {t("workspace.analyze.contactSupport")}
          </a>
        </div>
        {state.retryError ? <p className="text-sm">{state.retryError}</p> : null}
      </div>
    );
  }

  if (running && analyzeSlow(state.analyzeWatch, now)) {
    return (
      <div
        role="status"
        data-testid="analyze-slow"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
      >
        <span className="min-w-0 flex-1">{t("workspace.analyze.slow")}</span>
        <Button size="sm" variant="outline" onClick={onRefresh}>
          {t("workspace.analyze.refresh")}
        </Button>
      </div>
    );
  }
  return null;
}
