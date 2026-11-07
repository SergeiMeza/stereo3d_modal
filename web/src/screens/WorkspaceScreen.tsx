"use client";

/**
 * Project workspace — a DaVinci-Resolve-style paged screen: a slim project
 * header (with the 3D method switch), one full-width page per pipeline
 * stage, and a left page rail. The pages follow the project's method:
 * Classic Media · Cut · Depth · Stereo · Deliver · History; Lifelike Media ·
 * Cut · Preview · Deliver · History. Pages switch with the rail or the
 * number keys; the active page persists in the URL hash (#tab=…).
 *
 * Loads the project (GET /v1/projects/{id}); while analyze is running it
 * polls every 3 s. The Cut page owns the frame-accurate scene-cut editor;
 * each paid step is its own page (StepTab → Depth/Stereo/Deliver panel);
 * History lists every conversion.
 */

import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";

import {
  AnalyzeProgress,
  analyzePercent,
  analyzeStageLabel,
  formatEtaLeft,
} from "@/components/projects/AnalyzeBadge";
import { FirstTimeHint } from "@/components/onboarding/FirstTimeHint";
import { ProSavingsCard } from "@/components/plans/ProSavingsCard";
import { WorkspaceTips } from "@/components/onboarding/WorkspaceTips";
import {
  HistoryList,
} from "@/components/steps/HistoryList";
import { UPLOAD_AGAIN } from "@/lib/api/client";
import { OverviewTab } from "@/components/workspace/OverviewTab";
import { MethodBadge } from "@/components/workspace/MethodChooser";
import { PageHeader } from "@/components/workspace/PageHeader";
import {
  PageTabs,
  tabFromSlug,
  tabForMethod,
  tabOrderFor,
  tabsFor,
  type WorkspaceTabId,
} from "@/components/workspace/PageTabs";
import { SceneCutEditor } from "@/components/workspace/SceneCutEditor";
import { ShortcutsSheet } from "@/components/workspace/ShortcutsSheet";
import { StepTab } from "@/components/workspace/StepTab";
import { isTypingTarget } from "@/components/workspace/usePlayerShortcuts";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  applyProjectUpdateAtom,
  loadProjectAtom,
  projectAtom,
  retryAnalyzeAtom,
  watchAnalyze,
  workspaceTabAtom,
} from "@/components/workspace/workspaceAtoms";
import { AnalyzeNotice } from "@/components/workspace/AnalyzeNotice";
import { ProjectStateProvider } from "@/lib/state/stores";
import { SourceBusinessLine } from "@/components/plans/SourceBusinessLine";
import {
  canChooseMethod,
  methodOf,
  type Project,
  type Step,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useLimits } from "@/lib/api/useLimits";
import { videoFacts } from "@/lib/glossary";
import { retainOpenProject } from "@/lib/live/hub";
import { RUN_TERMINAL } from "@/lib/live/liveStore";
import { useLiveProject } from "@/lib/live/useLive";

/** What the live feed says that the page's last read doesn't: a run now
 * finished, or the analysis or profile job in another state ("" when
 * nothing). */
export function readAgainKey(loaded: Project, live: Project): string {
  const parts: string[] = [];
  if (loaded.analyze.state !== live.analyze.state) parts.push(`a:${live.analyze.state}`);
  if ((loaded.profile?.state ?? "") !== (live.profile?.state ?? "")) parts.push(`p:${live.profile?.state ?? ""}`);
  const before = new Map((loaded.conversions ?? []).map((c) => [c.conversion_id, c.state]));
  for (const c of live.conversions ?? []) {
    if (RUN_TERMINAL.has(c.state) && before.get(c.conversion_id) !== c.state) parts.push(`${c.conversion_id}:${c.state}`);
  }
  return parts.join(",");
}

const STEP_BY_TAB: Partial<Record<WorkspaceTabId, Step>> = {
  depth: "depth_preview",
  look: "stereo_preview",
  preview: "lifelike_preview",
  make: "production",
};

function initialTab(): WorkspaceTabId {
  // Default page is the Overview (S3D-25); a URL hash still wins, old slugs
  // (#tab=media, cut, stereo, deliver, history) included.
  if (typeof window === "undefined") return "overview";
  const m = /(?:^#|&)tab=([a-z]+)/.exec(window.location.hash);
  return (m && tabFromSlug(m[1])) ?? "overview";
}

export interface WorkspaceScreenProps {
  projectId: string;
}

/** ADR 0138: each project page has its own store, so opening another
 * project starts clean while its tabs share one. */
export default function WorkspaceScreen(props: WorkspaceScreenProps) {
  return (
    <ProjectStateProvider key={props.projectId} projectId={props.projectId}>
      <Workspace {...props} />
    </ProjectStateProvider>
  );
}

function Workspace({ projectId }: WorkspaceScreenProps) {
  const gateway = useGateway();
  // ADR 0138: the project, its load error and the analysis retry live in
  // the project's atom (workspaceAtoms); the action atoms write them
  const [projectState, setProjectState] = useAtom(projectAtom(projectId));
  const { project: loaded, loadError, retrying } = projectState;
  // owner 2026-11-07: the project with the live feed on top (its analysis,
  // its profile job, every run), so every tab shows the same moment
  const project = useLiveProject(loaded);
  const load = useSetAtom(loadProjectAtom);
  const applyUpdate = useSetAtom(applyProjectUpdateAtom);
  const retry = useSetAtom(retryAnalyzeAtom);
  const [tabChoice, setTabState] = useAtom(workspaceTabAtom);
  const tab = tabChoice ?? initialTab();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [idCopied, setIdCopied] = useState(false);

  const setTab = useCallback(
    (t: WorkspaceTabId) => {
      setTabState(t);
      window.history.replaceState(null, "", `#tab=${t}`);
    },
    [setTabState],
  );

  // Follow external hash changes (back/forward, pasted #tab=… links).
  useEffect(() => {
    const onHashChange = () => setTabState(initialTab());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [setTabState]);

  const refetch = useCallback(
    async () => load({ client: gateway, projectId }),
    [load, gateway, projectId],
  );

  // A PATCH answer (method switch) keeps the runs we have
  const applyProjectUpdate = useCallback((next: Project) => applyUpdate(next), [applyUpdate]);

  // Failed analyses are retryable (transient upstream failures shouldn't
  // force a re-upload); success flips analyze back to running, which
  // restarts the poll loop below.
  const retryAnalyze = useCallback(
    async () => retry({ client: gateway, projectId }),
    [retry, gateway, projectId],
  );

  useEffect(() => {
    // Initial load; deferred a tick so state updates stay out of the
    // effect body (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => void refetch(), 0);
    return () => clearTimeout(timer);
  }, [refetch]);

  // the slow poll (stream down) reads open project pages again
  useEffect(() => retainOpenProject(projectId), [projectId]);

  // owner 2026-11-07: no timers here. When the live feed says a run of
  // this project finished, or its analysis or profile job changed state,
  // read the project again once (files, probe, scenes, profile).
  const readAgain = loaded && project ? readAgainKey(loaded, project) : "";
  useEffect(() => {
    if (readAgain !== "") void refetch();
  }, [readAgain, refetch]);

  // the "taking longer than usual" watch follows the live analysis
  const analyzeKey = project ? `${project.analyze.state}|${project.analyze.stage ?? ""}|${project.analyze.progress ?? ""}` : "";
  useEffect(() => {
    if (!project || analyzeKey === "") return;
    setProjectState((s) => {
      const w = watchAnalyze(s.analyzeWatch, project);
      return w === s.analyzeWatch ? s : { ...s, analyzeWatch: w };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the analysis only
  }, [analyzeKey, setProjectState]);

  // The rail follows the project's method (classic until it has loaded).
  const method = methodOf(project);
  // Hide the method choice when Lifelike can't be chosen (GET /v1/limits).
  const limits = useLimits();
  const tabOrder = tabOrderFor(method);

  // Page switching (number keys) and the shortcuts sheet (?/Esc). The Cut
  // page's transport/editing keys live in SceneCutEditor, mounted only there.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey)
        return;
      const digit = Number(e.key);
      if (digit >= 1 && digit <= tabOrder.length) {
        setTab(tabOrder[digit - 1]);
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      } else if (e.key === "Escape") {
        setShortcutsOpen(false);
      }
    }
    // eslint-disable-next-line no-restricted-syntax -- workspace keyboard shortcuts, not an overlay
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setTab, tabOrder]);

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

  // No page is locked (S3D-28): the 3D look page makes its own depth when
  // there is no depth run yet.
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
          Getting your video ready: finding its scenes and making a preview.
          This step is free, and the page updates by itself.
        </p>
      </div>
    </div>
  );

  // A link (or the other method's page) that this method's rail doesn't
  // have maps onto its counterpart: Depth/Stereo ↔ Preview.
  const page = tabForMethod(tab, method);
  const step = STEP_BY_TAB[page];
  // S3D-24: erased files — the project and its run history stay, with no
  // download or run actions
  const filesDeleted = project.files_deleted_at !== undefined;

  return (
    <>
      <section className="flex h-[calc(100vh-3rem)] flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge bg-surface-1 px-4 py-2">
          {/* owner 2026-11-05 (iPhone): a long file name without spaces
              made the page scroll sideways; it truncates instead */}
          <h1
            data-testid="workspace-title"
            title={project.name || undefined}
            className="min-w-0 max-w-full truncate text-sm font-semibold tracking-tight"
          >
            {project.name || "Untitled project"}
          </h1>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => void copyProjectId()}
                className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg-muted hover:text-fg"
              >
                {idCopied ? "Copied" : "Support info"}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Copies this project&apos;s id ({project.project_id}) — quote it to
              support
            </TooltipContent>
          </Tooltip>
          <MethodBadge
            project={project}
            onChanged={applyProjectUpdate}
            allowMove={!filesDeleted && canChooseMethod(limits, project)}
          />
          {project.analyze.state === "running" ? (
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
          ) : project.analyze.state === "failed" && !filesDeleted ? (
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
              {videoFacts(project)}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
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
              <TooltipContent
                side="bottom"
                className="flex items-center gap-1.5"
              >
                Keyboard shortcuts <kbd>?</kbd>
              </TooltipContent>
            </Tooltip>
          </div>
        </header>
        {/* owner 2026-11-04: high-end sources are guided to Business */}
        <SourceBusinessLine project={project} />

        {filesDeleted ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="mx-auto flex max-w-4xl flex-col gap-3">
              <PageHeader
                title="Files"
                description={`Files deleted on ${new Intl.DateTimeFormat(
                  "en-US",
                  {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  },
                ).format(new Date(project.files_deleted_at!))}`}
              />
              <p
                data-testid="files-deleted-line"
                className="text-sm text-fg-muted"
              >
                {UPLOAD_AGAIN}.
              </p>
              <HistoryList project={project} />
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <PageTabs tabs={tabsFor(method)} active={page} onChange={setTab} />
            {/* onboarding: four short tips the first time (owner 2026-11-04) */}
            {method === "lifelike" ? <WorkspaceTips /> : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {/* owner bug 2026-11-05: a slow or failed analysis says so */}
              <AnalyzeNotice
                state={projectState}
                onRefresh={() => void refetch()}
                onRetry={() => void retryAnalyze()}
              />
              {page === "overview" ? (
                <OverviewTab
                  project={project}
                  onNavigate={setTab}
                  onProjectChanged={
                    canChooseMethod(limits, project)
                      ? applyProjectUpdate
                      : undefined
                  }
                  onProjectUpdated={applyProjectUpdate}
                />
              ) : page === "scenes" ? (
                <>
                  <FirstTimeHint id="scenes" className="mb-3" />
                  {project.analyze.state === "failed" ? (
                    // the notice above says it and offers Try again
                    null
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
                  )}
                </>
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
                    title="Files"
                    description="Kept while you use this project; deleted after 90 days without use."
                      />
                  {/* plans canvas, Receipt A */}
                  <ProSavingsCard project={project} />
                  <HistoryList project={project} />
                </div>
              )}
            </div>
          </div>
        )}

        <ShortcutsSheet
          open={shortcutsOpen}
          onOpenChange={setShortcutsOpen}
          tabs={tabsFor(method)}
        />
      </section>
    </>
  );
}
