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
import { openProjectIdAtom } from "@/lib/state/projectScope";
import type { WorkspaceTabId } from "./PageTabs";

import { loadErrorText } from "@/components/steps/loadErrorText";

export interface ProjectState {
  project: Project | null;
  loadError: string | null;
  retrying: boolean;
  retryError: string | null;
}

const EMPTY: ProjectState = { project: null, loadError: null, retrying: false, retryError: null };

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

const NOT_AVAILABLE = "This project isn't available. It may have been removed.";

/** GET the project again. */
export const loadProjectAtom = atom(
  null,
  async (_get, set, a: { client: Pick<GatewayClient, "getProject">; projectId: string }): Promise<void> => {
    const at = projectAtom(a.projectId);
    try {
      const project = await a.client.getProject(a.projectId);
      set(at, (s) => ({ ...s, project, loadError: null }));
    } catch (e) {
      set(at, (s) => ({ ...s, loadError: loadErrorText(e, false, NOT_AVAILABLE) }));
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
  async (_get, set, a: { client: Pick<GatewayClient, "retryAnalyze">; projectId: string }): Promise<void> => {
    const at = projectAtom(a.projectId);
    set(at, (s) => ({ ...s, retrying: true, retryError: null }));
    try {
      const project = await a.client.retryAnalyze(a.projectId);
      set(at, (s) => ({ ...s, project, retrying: false }));
    } catch (e) {
      set(at, (s) => ({
        ...s,
        retrying: false,
        retryError:
          e instanceof GatewayError ? e.message : "Could not restart the analysis — please try again.",
      }));
    }
  },
);

/** The workspace page shown (null: from the URL hash). */
export const workspaceTabAtom = atom<WorkspaceTabId | null>(null);
