"use client";

/**
 * Reading live status (owner 2026-11-07). Every surface that shows a run's
 * or a project's status reads it through these hooks, never through its
 * own poll: the run or project as the page read it, with the live atoms
 * (app store) on top when they are newer. Using one keeps the stream open.
 */

import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";

import type { Conversion, Project } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { appStore } from "@/lib/state/stores";

import type { LiveRun } from "./events";
import { retainLive } from "./hub";
import {
  liveProjectAtom,
  liveStatusAtom,
  mergeProject,
  mergeRun,
  projectRunIdsAtom,
  runAtom,
  type LiveStatus,
} from "./liveStore";

const APP = { store: appStore };

/** Keep the signed-in user's stream open while this is mounted. */
export function useLiveFeed(): void {
  const { user } = useAuth();
  const client = useGateway();
  const uid = user?.uid ?? null;
  useEffect(() => {
    if (uid === null) return;
    return retainLive(uid, client);
  }, [uid, client]);
}

/** The stream's state. */
export function useLiveStatus(): LiveStatus {
  return useAtomValue(liveStatusAtom, APP);
}

/** One run, live. */
export function useLiveRun(base: Conversion): Conversion {
  useLiveFeed();
  const live = useAtomValue(runAtom(base.conversion_id), APP);
  return useMemo(() => mergeRun(base, live), [base, live]);
}

/** One run (or none), live. */
export function useLiveRunOrNull(base: Conversion | null): Conversion | null {
  useLiveFeed();
  const live = useAtomValue(runAtom(base?.conversion_id ?? ""), APP);
  return useMemo(() => (base === null ? null : mergeRun(base, live)), [base, live]);
}

/** One run by id as the live feed knows it (null when it said nothing). */
export function useLiveRunById(conversionId: string): LiveRun | null {
  useLiveFeed();
  return useAtomValue(runAtom(conversionId), APP);
}

/** A project with its runs, live. */
export function useLiveProject(base: Project): Project;
export function useLiveProject(base: Project | null): Project | null;
export function useLiveProject(base: Project | null): Project | null {
  useLiveFeed();
  const derived = useMemo(
    () =>
      atom((get) => {
        if (base === null) return null;
        const id = base.project_id;
        return mergeProject(base, get(liveProjectAtom(id)), get(projectRunIdsAtom(id)), (rid) => get(runAtom(rid)));
      }),
    [base],
  );
  return useAtomValue(derived, APP);
}

/** Has the live feed heard this project was deleted? */
export function useLiveDeleted(projectId: string): boolean {
  return useAtomValue(liveProjectAtom(projectId), APP)?.deleted === true;
}

/** Of these projects, the ones the live feed heard were deleted. */
export function useLiveDeletedIds(projectIds: readonly string[]): ReadonlySet<string> {
  const key = projectIds.join(",");
  const derived = useMemo(
    () =>
      atom((get) => {
        const gone = key === "" ? [] : key.split(",").filter((id) => get(liveProjectAtom(id))?.deleted === true);
        return gone.join(",");
      }),
    [key],
  );
  const gone = useAtomValue(derived, APP);
  return useMemo(() => new Set(gone === "" ? [] : gone.split(",")), [gone]);
}
