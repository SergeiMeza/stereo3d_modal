"use client";

/**
 * Project workspace — a DaVinci-Resolve-style paged screen: a slim project
 * header, one full-width page per pipeline stage (Media · Cut · Depth ·
 * Stereo · Deliver · History), and a left page rail. Pages switch with the
 * rail or the 1–6 keys; the active page persists in the URL hash (#tab=…).
 *
 * Loads the project (GET /v1/projects/{id}); while analyze is running it
 * polls every 3 s. The Cut page owns the frame-accurate scene-cut editor;
 * each paid step is its own page (StepTab → Depth/Stereo/Deliver panel);
 * History lists every conversion.
 */

import { useCallback, useEffect, useState } from "react";

import {
  AnalyzeProgress,
  analyzePercent,
  analyzeStageLabel,
  formatEtaLeft,
} from "@/components/projects/AnalyzeBadge";
import { HistoryList } from "@/components/steps/HistoryList";
import { formatCents } from "@/components/steps/money";
import { MediaTab } from "@/components/workspace/MediaTab";
import { PageHeader } from "@/components/workspace/PageHeader";
import {
  PageTabs,
  TAB_ORDER,
  isWorkspaceTabId,
  type WorkspaceTabId,
} from "@/components/workspace/PageTabs";
import { SceneCutEditor } from "@/components/workspace/SceneCutEditor";
import { ShortcutsSheet } from "@/components/workspace/ShortcutsSheet";
import { StepTab } from "@/components/workspace/StepTab";
import { isTypingTarget } from "@/components/workspace/usePlayerShortcuts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { GatewayError } from "@/lib/api/client";
import type { Project, Step } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

const ANALYZE_POLL_MS = 3000;

const STEP_BY_TAB: Partial<Record<WorkspaceTabId, Step>> = {
  depth: "depth_preview",
  stereo: "stereo_preview",
  deliver: "production",
};

function initialTab(): WorkspaceTabId {
  // Default page is Media (the source at a glance) — a fresh/analyzed
  // project should orient the user before editing; a URL hash still wins.
  if (typeof window === "undefined") return "media";
  const m = /(?:^#|&)tab=([a-z]+)/.exec(window.location.hash);
  return m && isWorkspaceTabId(m[1]) ? m[1] : "media";
}

export interface WorkspaceScreenProps {
  projectId: string;
  /** Test hook — polling cadence while analyze.state === "running". */
  pollIntervalMs?: number;
}

export default function WorkspaceScreen({
  projectId,
  pollIntervalMs = ANALYZE_POLL_MS,
}: WorkspaceScreenProps) {
  const gateway = useGateway();
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTabState] = useState<WorkspaceTabId>(initialTab);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const setTab = useCallback((t: WorkspaceTabId) => {
    setTabState(t);
    window.history.replaceState(null, "", `#tab=${t}`);
  }, []);

  // Follow external hash changes (back/forward, pasted #tab=… links).
  useEffect(() => {
    const onHashChange = () => setTabState(initialTab());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const refetch = useCallback(async () => {
    try {
      setProject(await gateway.getProject(projectId));
      setLoadError(null);
    } catch (e) {
      setLoadError(
        e instanceof GatewayError ? e.message : "Failed to load the project.",
      );
    }
  }, [gateway, projectId]);

  // Failed analyses are retryable (transient upstream failures shouldn't
  // force a re-upload); success flips analyze back to running, which
  // restarts the poll loop below.
  const retryAnalyze = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      setProject(await gateway.retryAnalyze(projectId));
    } catch (e) {
      setRetryError(
        e instanceof GatewayError
          ? e.message
          : "Could not restart the analysis — please try again.",
      );
    } finally {
      setRetrying(false);
    }
  }, [gateway, projectId]);

  useEffect(() => {
    // Initial load; deferred a tick so state updates stay out of the
    // effect body (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => void refetch(), 0);
    return () => clearTimeout(timer);
  }, [refetch]);

  const analyzing = project?.analyze.state === "running";
  useEffect(() => {
    if (!analyzing) return;
    const timer = setInterval(() => void refetch(), pollIntervalMs);
    return () => clearInterval(timer);
  }, [analyzing, pollIntervalMs, refetch]);

  // Page switching (1–6) and the shortcuts sheet (?/Esc). The Cut page's
  // transport/editing keys live in SceneCutEditor, mounted only there.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey)
        return;
      const digit = Number(e.key);
      if (digit >= 1 && digit <= TAB_ORDER.length) {
        setTab(TAB_ORDER[digit - 1]);
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      } else if (e.key === "Escape") {
        setShortcutsOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setTab]);

  async function copyProjectId() {
    if (!project) return;
    try {
      await navigator.clipboard.writeText(project.project_id);
      setIdCopied(true);
      setTimeout(() => setIdCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the id is still selectable */
    }
  }

  if (!project) {
    return (
      <section className="px-4 py-6">
        {loadError ? (
          <div role="alert" className="space-y-2">
            <p className="text-red-400">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <p data-testid="workspace-loading" className="text-fg-muted">
            Loading project…
          </p>
        )}
      </section>
    );
  }

  const { probe, scenes } = project;
  const ready =
    project.analyze.state === "succeeded" &&
    probe !== undefined &&
    scenes !== undefined;

  // The Stereo page builds on the Cut page's scenes AND a depth map — a
  // succeeded Depth run or an uploaded one. It stays locked until both
  // exist (the rail disables the tab; deep links get an explanatory card
  // instead of the panel).
  const hasDepthMap =
    project.depth_upload !== undefined ||
    (project.conversions ?? []).some(
      (c) => c.step === "depth_preview" && c.state === "succeeded",
    );
  const stereoLockReason = !ready
    ? "Stereo unlocks after analysis — scene cuts come first"
    : !hasDepthMap
      ? "Run a Depth preview (or upload a depth map) first — Stereo builds on it"
      : undefined;
  const locked: Partial<Record<WorkspaceTabId, string>> = stereoLockReason
    ? { stereo: stereoLockReason }
    : {};

  const analyzingCard = (
    <div
      data-testid="analyzing-state"
      className="flex items-center gap-3 rounded-md border border-edge bg-surface-1 p-6 text-fg-muted"
    >
      <span
        aria-hidden
        className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent"
      />
      <div className="min-w-0 flex-1">
        <AnalyzeProgress analyze={project.analyze} />
        <p className="mt-1 text-sm">
          Probing the video, detecting scene cuts and crop geometry, rendering
          filmstrip thumbnails. This page refreshes automatically.
        </p>
      </div>
    </div>
  );

  const step = STEP_BY_TAB[tab];

  return (
    <section className="flex h-[calc(100vh-3rem)] flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge bg-surface-1 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-tight">
          {project.name || "Untitled project"}
        </h1>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void copyProjectId()}
              className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted hover:text-fg"
            >
              {idCopied ? "copied" : project.project_id}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Copy project id — quote this to support
          </TooltipContent>
        </Tooltip>
        {analyzing ? (
          <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
            <span
              aria-hidden
              className="h-2.5 w-2.5 animate-spin rounded-full border border-primary border-t-transparent"
            />
            {analyzeStageLabel(project.analyze.stage)}…
            {analyzePercent(project.analyze) !== null ? (
              <span className="font-mono">
                {analyzePercent(project.analyze)}%
              </span>
            ) : null}
            {project.analyze.eta_seconds !== undefined &&
            project.analyze.eta_seconds > 0 ? (
              <span>{formatEtaLeft(project.analyze.eta_seconds)}</span>
            ) : null}
          </span>
        ) : project.analyze.state === "failed" ? (
          <span className="flex items-center gap-2">
            <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] text-red-400">
              Analyze failed
            </span>
            <button
              type="button"
              disabled={retrying}
              onClick={() => void retryAnalyze()}
              className="rounded border border-edge bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {retrying ? "Retrying…" : "Retry analysis"}
            </button>
          </span>
        ) : probe ? (
          <span className="text-[11px] text-fg-muted">
            {probe.width}×{probe.height} · {probe.fps_rational} fps ·{" "}
            {probe.num_frames} frames
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {project.analyze.credit_available ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                >
                  {formatCents(project.analyze.credit_cents)} credit
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Free analysis — credited on this project&apos;s first paid
                conversion
              </TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Keyboard shortcuts"
                onClick={() => setShortcutsOpen((o) => !o)}
                className="rounded border border-edge bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-fg-muted hover:text-fg"
              >
                ?
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="flex items-center gap-1.5">
              Keyboard shortcuts <kbd>?</kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <PageTabs active={tab} onChange={setTab} locked={locked} />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {tab === "media" ? (
            <MediaTab project={project} onNavigate={setTab} />
          ) : tab === "cut" ? (
            project.analyze.state === "failed" ? (
              <div
                role="alert"
                className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-red-300"
              >
                <p className="font-medium">Analysis failed.</p>
                {project.analyze.error ? (
                  <p className="mt-1 text-sm">{project.analyze.error}</p>
                ) : null}
                <button
                  type="button"
                  disabled={retrying}
                  onClick={() => void retryAnalyze()}
                  className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {retrying ? "Retrying…" : "Retry analysis"}
                </button>
                {retryError ? (
                  <p className="mt-2 text-sm">{retryError}</p>
                ) : null}
              </div>
            ) : ready ? (
              <SceneCutEditor
                projectId={project.project_id}
                projectName={project.name}
                probe={probe}
                scenes={scenes}
                crop={project.crop}
                previewUrl={project.preview_url}
                stripThumbs={project.strip_thumbs ?? []}
                sceneThumbs={project.scene_thumbs ?? []}
                onProjectChanged={refetch}
              />
            ) : (
              analyzingCard
            )
          ) : tab === "stereo" && stereoLockReason ? (
            // Deep links (#tab=stereo) and the number keys can still land
            // here while locked — explain instead of rendering the panel.
            <div
              data-testid="stereo-locked"
              className="mx-auto flex max-w-xl flex-col items-start gap-3 rounded-md border border-edge bg-surface-1 p-6"
            >
              <h2 className="text-sm font-semibold">Stereo is locked</h2>
              <p className="text-sm text-fg-muted">{stereoLockReason}.</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTab(ready ? "depth" : "cut")}
                >
                  {ready ? "Go to Depth" : "Go to Cut"}
                </Button>
              </div>
            </div>
          ) : step ? (
            <StepTab
              step={step}
              project={project}
              onProjectChanged={() => void refetch()}
              onNavigate={setTab}
            />
          ) : (
            <div className="mx-auto flex max-w-4xl flex-col gap-3">
              <PageHeader
                title="History"
                description="Something off with a run? Click its id to copy it and quote it to support — every conversion is traceable end-to-end by that id."
              />
              <HistoryList project={project} />
            </div>
          )}
        </div>
      </div>

      <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </section>
  );
}
