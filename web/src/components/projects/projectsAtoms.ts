"use client";

/**
 * The project list (GET /v1/projects, ADR 0138): the projects and the
 * archived ones, in app-store atoms for the account they were read for,
 * written by the load actions. The gateway client is an action argument.
 */

import { atom } from "jotai";

import { GatewayError, type GatewayClient } from "@/lib/api/client";
import type { Project } from "@/lib/api/types";
import { billingUidAtom } from "@/lib/billing";

export interface ProjectListState {
  uid: string | null;
  projects: Project[] | null;
  archived: Project[] | null;
  loadError: string | null;
  /** a failed archived load or project change, until dismissed */
  actionError: string | null;
}

export const EMPTY_PROJECT_LIST: ProjectListState = {
  uid: null,
  projects: null,
  archived: null,
  loadError: null,
  actionError: null,
};

export const projectListAtom = atom<ProjectListState>(EMPTY_PROJECT_LIST);

type Lister = Pick<GatewayClient, "listProjects">;

/** Owner bug 2026-11-05: a list that fails, hangs or answers without a
 * list is an error with Retry, never "No projects yet". */
export const PROJECTS_TIMEOUT_MS = 15_000;
export const PROJECTS_FAILED = "Couldn't load your projects.";

function inTime<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), PROJECTS_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** The projects (or the archived ones). */
export const loadProjectsAtom = atom(
  null,
  async (get, set, a: { client: Lister; archived?: boolean }): Promise<void> => {
    const uid = get(billingUidAtom);
    const mine = (s: ProjectListState): ProjectListState => (s.uid === uid ? s : { ...EMPTY_PROJECT_LIST, uid });
    try {
      const res = await inTime(a.archived ? a.client.listProjects(true) : a.client.listProjects());
      if (get(billingUidAtom) !== uid) return;
      if (!Array.isArray(res?.projects)) throw new Error("no list");
      set(projectListAtom, (s) =>
        a.archived
          ? { ...mine(s), archived: res.projects }
          : { ...mine(s), projects: res.projects, loadError: null },
      );
    } catch (e) {
      if (get(billingUidAtom) !== uid) return;
      set(projectListAtom, (s) =>
        a.archived
          ? {
              ...mine(s),
              actionError: e instanceof GatewayError ? e.message : "Failed to load archived projects.",
            }
          : {
              ...mine(s),
              loadError: e instanceof GatewayError && e.message ? `${PROJECTS_FAILED} ${e.message}` : PROJECTS_FAILED,
            },
      );
    }
  },
);

/** Owner bug 2026-11-05 (the list said "No projects yet" after an
 * upload): a new project joins the list at once, whatever page made it;
 * the next read confirms it. */
export const projectCreatedAtom = atom(null, (get, set, project: Project) => {
  const uid = get(billingUidAtom);
  set(projectListAtom, (s) => {
    if (s.uid !== uid || s.projects === null) return s;
    if (s.projects.some((p) => p.project_id === project.project_id)) return s;
    return { ...s, projects: [project, ...s.projects], loadError: null };
  });
});

/** Show (or clear) the error of a project change. */
export const projectActionErrorAtom = atom(null, (get, set, message: string | null) => {
  set(projectListAtom, (s) => ({ ...s, actionError: message }));
});
