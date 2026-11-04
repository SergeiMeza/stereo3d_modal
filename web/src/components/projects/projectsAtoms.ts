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

/** The projects (or the archived ones). */
export const loadProjectsAtom = atom(
  null,
  async (get, set, a: { client: Lister; archived?: boolean }): Promise<void> => {
    const uid = get(billingUidAtom);
    const mine = (s: ProjectListState): ProjectListState => (s.uid === uid ? s : { ...EMPTY_PROJECT_LIST, uid });
    try {
      const res = a.archived ? await a.client.listProjects(true) : await a.client.listProjects();
      if (get(billingUidAtom) !== uid) return;
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
          : { ...mine(s), loadError: e instanceof GatewayError ? e.message : "Failed to load projects." },
      );
    }
  },
);

/** Show (or clear) the error of a project change. */
export const projectActionErrorAtom = atom(null, (get, set, message: string | null) => {
  set(projectListAtom, (s) => ({ ...s, actionError: message }));
});
