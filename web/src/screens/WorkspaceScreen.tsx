"use client";

/**
 * Project workspace — a DaVinci-Resolve-style paged screen: a slim project
 * header, one full-width page per pipeline stage (Media · Cut · Depth ·
 * Stereo · Deliver · History), and a bottom page bar. Pages switch with the
 * bar or the 1–6 keys; the active page persists in the URL hash (#tab=…).
 *
 * Loads the project (GET /v1/projects/{id}); while analyze is running it
 * polls every 3 s. The Cut page owns the frame-accurate scene-cut editor;
 * each paid step is its own page (StepTab → Depth/Stereo/Deliver panel);
 * History lists every conversion.
 */

import { useCallback, useEffect, useState } from "react";

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
  if (typeof window === "undefined") return "cut";
  const m = /(?:^#|&)tab=([a-z]+)/.exec(window.location.hash);
  return m && isWorkspaceTabId(m[1]) ? m[1] : "cut";
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

  const analyzingCard = (
    <div
      data-testid="analyzing-state"
      className="flex items-center gap-3 rounded-md border border-edge bg-surface-1 p-6 text-fg-muted"
    >
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent"
      />
      <div>
        <p className="font-medium text-fg">Analyzing source…</p>
        <p className="text-sm">
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
            Analyzing…
          </span>
        ) : project.analyze.state === "failed" ? (
          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] text-red-400">
            Analyze failed
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
            </div>
          ) : ready ? (
            <SceneCutEditor
              projectId={project.project_id}
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

      <PageTabs active={tab} onChange={setTab} />
      <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </section>
  );
}
