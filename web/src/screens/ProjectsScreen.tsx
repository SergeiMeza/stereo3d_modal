"use client";

/**
 * Projects screen — list of project cards + the upload dropzone
 * (web/DESIGN.md, screen 1). While any project's analyze is running the
 * list re-polls GET /v1/projects every 5s (cleared on unmount).
 *
 * Project management: pinned projects sort first under a "Pinned" section
 * header; a "Show archived" toggle fetches GET /v1/projects?archived=1 and
 * appends an Archived section (restore from there). Per-card updates PATCH
 * the project then reload whichever lists are on screen.
 */

import { useCallback, useEffect, useState } from "react";

import { GetStarted } from "@/components/onboarding/GetStarted";
import { PlansBanner } from "@/components/plans/PlansBanner";
import { TalkToUs } from "@/components/plans/TalkToUs";
import { WelcomeDialog } from "@/components/onboarding/WelcomeDialog";
import type { WelcomeVariant } from "@/components/onboarding/WelcomeDialog";
import { clearWelcomeAgain, welcomeAgainRequested } from "@/components/plans/ResetPlansSurfaces";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { LimitsNotice } from "@/components/pay/LimitsNotice";
import { UploadDropzone } from "@/components/projects/UploadDropzone";
import { GatewayError } from "@/lib/api/client";
import type { Project, UpdateProjectRequest } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useAccountSettings } from "@/lib/useAccountSettings";

const POLL_INTERVAL_MS = 5000;

const byNewest = (a: Project, b: Project) =>
  b.created_at.localeCompare(a.created_at);

export default function ProjectsScreen() {
  const gateway = useGateway();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [archived, setArchived] = useState<Project[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // onboarding (owner 2026-11-04): the welcome once per new account, then
  // the getting-started list; "Pick now" reopens the welcome
  const { settings } = useAccountSettings();
  const [welcomeAgain, setWelcomeAgain] = useState(false);
  const [welcomeClosed, setWelcomeClosed] = useState(false);

  const load = useCallback(() => {
    gateway.listProjects().then(
      (res) => {
        setProjects(res.projects);
        setLoadError(null);
      },
      (e: unknown) => {
        setLoadError(
          e instanceof GatewayError ? e.message : "Failed to load projects.",
        );
      },
    );
  }, [gateway]);

  const loadArchived = useCallback(() => {
    gateway.listProjects(true).then(
      (res) => setArchived(res.projects),
      (e: unknown) => {
        setActionError(
          e instanceof GatewayError
            ? e.message
            : "Failed to load archived projects.",
        );
      },
    );
  }, [gateway]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (showArchived) loadArchived();
  }, [showArchived, loadArchived]);

  // poll while anything moves: the free analysis or a 3D run
  const anyAnalyzing =
    projects?.some(
      (p) =>
        p.analyze.state === "running" ||
        ["created", "paid", "processing"].includes(p.summary?.latest_state ?? ""),
    ) ?? false;

  useEffect(() => {
    if (!anyAnalyzing) return;
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [anyAnalyzing, load]);

  const update = useCallback(
    async (id: string, req: UpdateProjectRequest) => {
      try {
        await gateway.updateProject(id, req);
        setActionError(null);
      } catch (e: unknown) {
        setActionError(
          e instanceof GatewayError ? e.message : "Failed to update project.",
        );
      }
      load();
      if (showArchived) loadArchived();
    },
    [gateway, load, loadArchived, showArchived],
  );

  const grid = (list: Project[]) => (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {list.map((p) => (
        <li key={p.project_id}>
          <ProjectCard
            project={p}
            onUpdate={(req) => update(p.project_id, req)}
          />
        </li>
      ))}
    </ul>
  );

  const sorted = projects === null ? null : [...projects].sort(byNewest);
  const sample = projects?.find((p) => p.sample === true) ?? null;
  // new accounts only: someone who already has their own projects
  // never gets the welcome (the gateway marks older accounts done too)
  const newAccount = projects !== null && projects.every((p) => p.sample === true);
  // app Pro (owner 2026-11-04): their own welcome once, also for an older
  // web account that later gets Pro in the app (then the Pro step alone).
  // "Show welcome again" (test only) brings either back for this session.
  const onboarding = settings?.onboarding;
  const again = welcomeAgainRequested();
  const appProDue = onboarding?.variant === "app_pro" && onboarding.app_pro_welcome_done !== true;
  const firstDue = onboarding?.welcome_done !== true && (newAccount || again);
  const welcomeVariant: WelcomeVariant = appProDue ? (firstDue ? "app_pro" : "app_pro_short") : "default";
  // "Pick now" reopens the welcome the account would get
  const shownVariant: WelcomeVariant = welcomeAgain
    ? onboarding?.variant === "app_pro" ? "app_pro" : "default"
    : welcomeVariant;
  const welcomeOpen =
    welcomeAgain || (!welcomeClosed && settings !== null && projects !== null && (appProDue || firstDue));
  const pinned = sorted?.filter((p) => p.pinned === true) ?? [];
  const rest = sorted?.filter((p) => p.pinned !== true) ?? [];

  return (
    <section className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
        <button
          type="button"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((v) => !v)}
          className="rounded-md border border-edge px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {showArchived ? "Hide archived" : "Show archived"}
          {archived !== null ? ` (${archived.length})` : ""}
        </button>
      </div>

      <WelcomeDialog
        key={shownVariant}
        open={welcomeOpen}
        sample={sample}
        variant={shownVariant}
        onClose={() => {
          clearWelcomeAgain();
          setWelcomeClosed(true);
          setWelcomeAgain(false);
        }}
      />
      <GetStarted onPickHeadset={() => setWelcomeAgain(true)} />
      <LimitsNotice />
      {/* plans canvas: Talk to us for company emails, then Projects A */}
      <TalkToUs />
      <PlansBanner />
      <UploadDropzone />

      {actionError !== null ? (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-400">
          <p className="flex-1">{actionError}</p>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="rounded-md border border-red-500/40 px-3 py-1.5 text-xs transition-colors hover:bg-red-500/20"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {loadError !== null ? (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-400">
          <p className="flex-1">{loadError}</p>
          <button
            type="button"
            onClick={load}
            className="rounded-md border border-red-500/40 px-3 py-1.5 text-xs transition-colors hover:bg-red-500/20"
          >
            Retry
          </button>
        </div>
      ) : sorted === null ? (
        <p className="text-fg-muted">Loading projects…</p>
      ) : sorted.length === 0 ? (
        <div className="rounded-lg border border-edge bg-surface-1 p-8 text-center">
          <p className="font-medium text-fg">No projects yet</p>
          <p className="mt-1 text-fg-muted">
            Drop a video above to start your first 3D conversion.
          </p>
        </div>
      ) : pinned.length > 0 ? (
        <>
          <h2 className="text-sm font-medium text-fg-muted">Pinned</h2>
          {grid(pinned)}
          {rest.length > 0 ? (
            <>
              <h2 className="text-sm font-medium text-fg-muted">
                All projects
              </h2>
              {grid(rest)}
            </>
          ) : null}
        </>
      ) : (
        grid(sorted)
      )}

      {showArchived ? (
        <div className="space-y-4">
          <h2 className="text-sm font-medium text-fg-muted">Archived</h2>
          {archived === null ? (
            <p className="text-fg-muted">Loading archived projects…</p>
          ) : archived.length === 0 ? (
            <p className="text-fg-muted">No archived projects.</p>
          ) : (
            grid([...archived].sort(byNewest))
          )}
        </div>
      ) : null}
    </section>
  );
}
