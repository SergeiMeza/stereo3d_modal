"use client";

/**
 * The open project (ADR 0138): one atom per project id with the project as
 * the gateway last sent it, why it didn't load, and the analysis retry.
 * The workspace's tabs, the run files, earlier runs and the run tracker
 * read it (the finished sample's wording included), and the action atoms
 * below are its only writers. The gateway client is an action argument.
 */

import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import { GatewayError, type GatewayClient } from "@/lib/api/client";
import type { Project } from "@/lib/api/types";
import { EN, type Tr } from "@/lib/i18n/t";
import { seedRuns } from "@/lib/live/liveStore";
import { openProjectIdAtom } from "@/lib/state/projectScope";
import { appStore } from "@/lib/state/stores";
import type { WorkspaceTabId } from "./PageTabs";

import { loadErrorText } from "@/components/steps/loadErrorText";

/** Owner bug 2026-11-05 (TEST sat on "Thumbnails… 70%" for minutes):
 * how long the analysis may sit still, and run at all, before the page
 * says it's taking longer than usual. */
export const ANALYZE_STALL_MS = 3 * 60_000;
export const ANALYZE_TOO_LONG_MS = 10 * 60_000;

/** The running analysis as this page has watched it: what it last said
 * (stage and progress), since when, and when it started. */
export interface AnalyzeWatch {
  key: string;
  since: number;
  started: number;
}

export interface ProjectState {
  project: Project | null;
  loadError: string | null;
  retrying: boolean;
  retryError: string | null;
  analyzeWatch: AnalyzeWatch | null;
}

const EMPTY: ProjectState = { project: null, loadError: null, retrying: false, retryError: null, analyzeWatch: null };

/** The watch after a fresh answer: a new stage or percent restarts "since";
 * the start is the upload time when it's recent (a reload mid-analysis),
 * else now. */
export function watchAnalyze(prev: AnalyzeWatch | null, project: Project, now = Date.now()): AnalyzeWatch | null {
  if (project.analyze.state !== "running") return null;
  const key = `${project.analyze.stage ?? ""}|${project.analyze.progress ?? ""}`;
  if (prev === null) {
    const created = Date.parse(project.created_at);
    const started = Number.isFinite(created) && now - created < 60 * 60_000 && created <= now ? created : now;
    return { key, since: now, started };
  }
  return key === prev.key ? prev : { ...prev, key, since: now };
}

/** Taking longer than usual: still for 3 minutes, or running for 10. */
export function analyzeSlow(w: AnalyzeWatch | null, now = Date.now()): boolean {
  return w !== null && (now - w.since >= ANALYZE_STALL_MS || now - w.started >= ANALYZE_TOO_LONG_MS);
}

export const projectAtom = atomFamily((projectId: string) => {
  void projectId;
  return atom<ProjectState>(EMPTY);
});

/** The project of this page's store (null outside a project page). */
export const openProjectAtom = atom((get) => {
  const id = get(openProjectIdAtom);
  return id === null ? null : get(projectAtom(id)).project;
});

/** The finished sample (owner 2026-11-04): its failures read "The sample
 * isn't available right now." */
export const isSampleAtom = atom((get) => get(openProjectAtom)?.sample === true);

/** GET the project again (t: the page's translator, default English). */
export const loadProjectAtom = atom(
  null,
  async (_get, set, a: { client: Pick<GatewayClient, "getProject">; projectId: string; t?: Tr }): Promise<void> => {
    const at = projectAtom(a.projectId);
    try {
      const project = await a.client.getProject(a.projectId);
      // its runs feed the live atoms (the slow poll knows the going ones)
      seedRuns(appStore, project.conversions);
      set(at, (s) => ({ ...s, project, loadError: null, analyzeWatch: watchAnalyze(s.analyzeWatch, project) }));
    } catch (e) {
      set(at, (s) => ({ ...s, loadError: loadErrorText(e, false, (a.t ?? EN)("workspace.load.notAvailable")) }));
    }
  },
);

/** A PATCH answer (method switch) is the project without its runs on some
 * gateways: keep the runs we have until the next load. */
export const applyProjectUpdateAtom = atom(null, (_get, set, next: Project) => {
  set(projectAtom(next.project_id), (s) => ({
    ...s,
    project: { ...next, conversions: next.conversions ?? s.project?.conversions },
  }));
});

/** Failed analyses are retryable; success flips analyze back to running. */
export const retryAnalyzeAtom = atom(
  null,
  async (_get, set, a: { client: Pick<GatewayClient, "retryAnalyze">; projectId: string; t?: Tr }): Promise<void> => {
    const at = projectAtom(a.projectId);
    set(at, (s) => ({ ...s, retrying: true, retryError: null }));
    try {
      const project = await a.client.retryAnalyze(a.projectId);
      // a new analysis: its clock starts now
      set(at, (s) => ({ ...s, project, retrying: false, analyzeWatch: watchAnalyze(null, { ...project, created_at: new Date().toISOString() }) }));
    } catch (e) {
      set(at, (s) => ({
        ...s,
        retrying: false,
        retryError:
          e instanceof GatewayError ? e.message : (a.t ?? EN)("workspace.analyze.restartFailed"),
      }));
    }
  },
);

/** The workspace page shown (null: from the URL hash). */
export const workspaceTabAtom = atom<WorkspaceTabId | null>(null);
