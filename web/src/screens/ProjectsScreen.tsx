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

import { deletionPromptAtom } from "@/lib/accountDeletion";
import { useCallback, useEffect, useState } from "react";

import { GetStarted } from "@/components/onboarding/GetStarted";
import { ProjectsNudge } from "@/components/plans/ProjectsNudge";
import { WelcomeDialog } from "@/components/onboarding/WelcomeDialog";
import { track } from "@/lib/analytics";
import type { WelcomeVariant } from "@/components/onboarding/WelcomeDialog";
import { clearWelcomeAgain } from "@/components/plans/ResetPlansSurfaces";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { LimitsNotice } from "@/components/pay/LimitsNotice";
import { UploadDropzone } from "@/components/projects/UploadDropzone";
import { GatewayError } from "@/lib/api/client";
import type { Project, UpdateProjectRequest } from "@/lib/api/types";
import { billingUidAtom } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";
import {
  loadProjectsAtom,
  projectActionErrorAtom,
  projectListAtom,
} from "@/components/projects/projectsAtoms";
import { useGateway } from "@/lib/api/useGateway";
import { useLiveDeletedIds } from "@/lib/live/useLive";
import { useAccountSettings } from "@/lib/useAccountSettings";

/** A modal dialog is open on the page. */
function modalOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="dialog"][data-open]') !== null
  );
}

const byNewest = (a: Project, b: Project) =>
  b.created_at.localeCompare(a.created_at);

export default function ProjectsScreen() {
  const t = useT();
  const gateway = useGateway();
  // ADR 0138: the list lives in app-store atoms (projectsAtoms)
  const list = useAppAtomValue(projectListAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const mine = list.uid === uid;
  // a project the live feed says was deleted (another tab, another
  // device) leaves the list at once
  const gone = useLiveDeletedIds([...(list.projects ?? []), ...(list.archived ?? [])].map((p) => p.project_id));
  const projects = mine ? (list.projects?.filter((p) => !gone.has(p.project_id)) ?? null) : null;
  const archived = mine ? (list.archived?.filter((p) => !gone.has(p.project_id)) ?? null) : null;
  const loadError = mine ? list.loadError : null;
  const actionError = mine ? list.actionError : null;
  const loadList = useAppSetAtom(loadProjectsAtom);
  const setActionError = useAppSetAtom(projectActionErrorAtom);
  const [showArchived, setShowArchived] = useState(false);
  // onboarding (owner 2026-11-04): the welcome once per new account, then
  // the getting-started list; "Pick now" reopens the welcome
  const { settings } = useAccountSettings();
  const [welcomeAgain, setWelcomeAgain] = useState(false);
  const [welcomeClosed, setWelcomeClosed] = useState(false);

  const load = useCallback(() => {
    void loadList({ client: gateway, t });
  }, [gateway, loadList, t]);

  const loadArchived = useCallback(() => {
    void loadList({ client: gateway, archived: true, t });
  }, [gateway, loadList, t]);

  // and again when the account changes
  useEffect(() => {
    load();
  }, [load, uid]);

  // owner bug 2026-11-05: a page left open (another tab, the phone
  // asleep, the back-forward cache) reads the list again when it comes
  // back, so it never shows a list it already had
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible" && !modalOpen()) load();
    };
    const shown = (e: PageTransitionEvent) => {
      if (e.persisted) load();
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    window.addEventListener("pageshow", shown);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
      window.removeEventListener("pageshow", shown);
    };
  }, [load]);

  useEffect(() => {
    if (showArchived) loadArchived();
  }, [showArchived, loadArchived]);

  // owner 2026-11-07: no list timer; each card follows its analysis and
  // runs through the live feed (lib/live), and the list is read again
  // when the page is shown

  const update = useCallback(
    async (id: string, req: UpdateProjectRequest) => {
      try {
        await gateway.updateProject(id, req);
        setActionError(null);
      } catch (e: unknown) {
        setActionError(
          e instanceof GatewayError ? e.message : t("projects.list.updateFailed"),
        );
      }
      load();
      if (showArchived) loadArchived();
    },
    [gateway, load, loadArchived, showArchived, setActionError, t],
  );

  // owner 2026-11-04: archive first, then delete (Archived view only); the
  // gateway's own words for a refusal (409 project_not_archived,
  // sample_not_deletable, a run in progress)
  const remove = useCallback(
    async (id: string) => {
      try {
        await gateway.deleteProject(id);
        track("project_deleted");
        setActionError(null);
      } catch (e: unknown) {
        setActionError(
          e instanceof GatewayError && e.message
            ? e.message
            : t("projects.list.deleteFailed"),
        );
      }
      load();
      if (showArchived) loadArchived();
    },
    [gateway, load, loadArchived, showArchived, setActionError, t],
  );

  const grid = (list: Project[]) => (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {list.map((p) => (
        <li key={p.project_id}>
          <ProjectCard
            project={p}
            onUpdate={(req) => update(p.project_id, req)}
            onDelete={
              p.archived === true && p.sample !== true
                ? () => remove(p.project_id)
                : undefined
            }
          />
        </li>
      ))}
    </ul>
  );

  const sorted = projects === null ? null : [...projects].sort(byNewest);
  const sample = projects?.find((p) => p.sample === true) ?? null;
  // app Pro (owner 2026-11-04): their own welcome once, also for an older
  // web account that later gets Pro in the app (then the Pro step alone).
  // "Show welcome again" (test only) resets the saved flags.
  const onboarding = settings?.onboarding;
  const appProDue =
    onboarding?.variant === "app_pro" &&
    onboarding.app_pro_welcome_done !== true;
  // owner 2026-11-05: every account sees the welcome once, older ones with
  // their own projects too, until closing or finishing it saves
  // welcome_done (the gateway's default is false unless it was saved)
  const firstDue = onboarding?.welcome_done !== true;
  const welcomeVariant: WelcomeVariant = appProDue
    ? firstDue
      ? "app_pro"
      : "app_pro_short"
    : "default";
  // "Pick now" reopens the welcome the account would get
  const shownVariant: WelcomeVariant = welcomeAgain
    ? onboarding?.variant === "app_pro"
      ? "app_pro"
      : "default"
    : welcomeVariant;
  const welcomeDue =
    welcomeAgain ||
    (!welcomeClosed &&
      settings !== null &&
      projects !== null &&
      (appProDue || firstDue));
  // owner bug 2026-11-05 (taps lost in the welcome on a new account): once
  // open, the welcome stays open with the variant it opened with until it
  // closes; a list reload (projects null for a moment) or a variant that
  // lands late no longer closes or remounts it
  const [openedAs, setOpenedAs] = useState<WelcomeVariant | null>(null);
  if (welcomeDue && openedAs === null) setOpenedAs(shownVariant);
  // owner 2026-11-07: an account set to be deleted asks that first
  const deletionAsked = useAppAtomValue(deletionPromptAtom) !== null;
  const welcomeOpen = !deletionAsked && (welcomeAgain || (openedAs !== null && !welcomeClosed));
  const dialogVariant = openedAs ?? shownVariant;
  const pinned = sorted?.filter((p) => p.pinned === true) ?? [];
  const rest = sorted?.filter((p) => p.pinned !== true) ?? [];

  return (
    <section className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t("projects.list.title")}</h1>
        <button
          type="button"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((v) => !v)}
          className="rounded-md border border-edge px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {archived !== null
            ? t(showArchived ? "projects.list.hideArchivedCount" : "projects.list.showArchivedCount", {
                count: archived.length,
              })
            : t(showArchived ? "projects.list.hideArchived" : "projects.list.showArchived")}
        </button>
      </div>

      <WelcomeDialog
        key={dialogVariant}
        open={welcomeOpen}
        sample={sample}
        variant={dialogVariant}
        onClose={() => {
          clearWelcomeAgain();
          setWelcomeClosed(true);
          setWelcomeAgain(false);
          setOpenedAs(null);
        }}
      />
      <GetStarted
        onPickHeadset={() => {
          setOpenedAs(null);
          setWelcomeAgain(true);
        }}
      />
      <LimitsNotice />
      {/* plans canvas: Talk to us for company emails, then Projects A */}
      <ProjectsNudge />
      {/* owner 2026-11-05: an empty list is one card, the drop zone */}
      <UploadDropzone first={sorted !== null && sorted.length === 0 && loadError === null} />

      {actionError !== null ? (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-400">
          <p className="flex-1">{actionError}</p>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="rounded-md border border-red-500/40 px-3 py-1.5 text-xs transition-colors hover:bg-red-500/20"
          >
            {t("projects.list.dismiss")}
          </button>
        </div>
      ) : null}

      {loadError !== null ? (
        <div data-testid="projects-error" className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-400">
          <p className="flex-1">{loadError}</p>
          <button
            type="button"
            onClick={load}
            className="rounded-md border border-red-500/40 px-3 py-1.5 text-xs transition-colors hover:bg-red-500/20"
          >
            {t("projects.list.retry")}
          </button>
        </div>
      ) : null}
      {/* owner bug 2026-11-05: "No projects yet" only after a list that
          came back empty; a failed one keeps what was shown before */}
      {sorted === null ? (
        loadError === null ? (
          <p className="text-fg-muted">{t("projects.list.loading")}</p>
        ) : null
      ) : sorted.length === 0 ? null : pinned.length > 0 ? (
        <>
          <h2 className="text-sm font-medium text-fg-muted">{t("projects.list.pinned")}</h2>
          {grid(pinned)}
          {rest.length > 0 ? (
            <>
              <h2 className="text-sm font-medium text-fg-muted">
                {t("projects.list.all")}
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
          <h2 className="text-sm font-medium text-fg-muted">{t("projects.list.archived")}</h2>
          {archived === null ? (
            <p className="text-fg-muted">{t("projects.list.loadingArchived")}</p>
          ) : archived.length === 0 ? (
            <p className="text-fg-muted">{t("projects.list.noArchived")}</p>
          ) : (
            grid([...archived].sort(byNewest))
          )}
        </div>
      ) : null}
    </section>
  );
}
