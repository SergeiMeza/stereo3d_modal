/**
 * Live status (owner 2026-11-07): one atom per run and one per project in
 * the APP store, fed only by the live hub (the event stream, its snapshot,
 * and the slow poll while the stream is down) and by the answers of the
 * page's own reads and actions. Every surface that shows a run's or a
 * project's status reads these (through lib/live/useLive), so the
 * Overview, Make 3D, Preview, Files and the project cards agree at every
 * moment. Kept free of UI imports (the test setup loads it).
 *
 * Order: each record keeps its `version` (the doc's update time in
 * microseconds); anything not newer is dropped, which covers duplicates,
 * a resume's replayed overlap and events out of order.
 */

import { atom } from "jotai";
import type { createStore } from "jotai";
import { atomFamily } from "jotai-family";

import type { Conversion, Project } from "@/lib/api/types";

import {
  projectFromRead,
  runFromRead,
  versionOf,
  type LiveBalance,
  type LiveEvent,
  type LiveFormats,
  type LiveHandoff,
  type LiveRun,
  type LiveSettle,
  type ProjectPatch,
} from "./events";

type Store = ReturnType<typeof createStore>;

export const RUN_TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "canceled", "expired"]);

/** One run as the live feed last knew it (null until it says anything). */
export const runAtom = atomFamily((conversionId: string) => {
  void conversionId;
  return atom<LiveRun | null>(null);
});

/** One project's own fields as the live feed last knew them. */
export const liveProjectAtom = atomFamily((projectId: string) => {
  void projectId;
  return atom<ProjectPatch | null>(null);
});

/** The runs the live feed knows for a project (new runs join here). */
export const projectRunIdsAtom = atomFamily((projectId: string) => {
  void projectId;
  return atom<readonly string[]>([]);
});

/** A run's format jobs and file names, as run.formats last said. */
export const liveFormatsAtom = atomFamily((runId: string) => {
  void runId;
  return atom<LiveFormats | null>(null);
});

/** A "pay on another device" code, as handoff.state last said. */
export const liveHandoffAtom = atomFamily((code: string) => {
  void code;
  return atom<LiveHandoff | null>(null);
});

/** A settle of what the account owes, as billing.updated last said. */
export const liveSettleAtom = atomFamily((settleId: string) => {
  void settleId;
  return atom<LiveSettle | null>(null);
});

/** The prepaid balance, as billing.updated last said. */
export const liveBalanceAtom = atom<LiveBalance | null>(null);

/** The newest billing event's version (settle or balance): a billing
 * read follows it. */
export const billingVersionAtom = atom<number>(0);

/** Counts the slow polls while the stream is down: what the stream
 * doesn't carry whole (a billing status, a handoff's end) reads again on
 * each. */
export const fallbackTickAtom = atom<number>(0);

export type LiveStatus = "idle" | "connecting" | "open" | "down" | "paused";

/** The stream: open, (re)connecting, down (the slow poll fills in),
 * paused (page hidden) or idle (signed out). */
export const liveStatusAtom = atom<LiveStatus>("idle");

/** Project pages open now, with how many: the slow poll reads them again. */
export const openProjectsAtom = atom<ReadonlyMap<string, number>>(new Map());

function versionOfRun(r: LiveRun | Conversion): number {
  const v = (r as LiveRun).version;
  return typeof v === "number" ? v : versionOf(r.updated_at);
}

function versionOfProject(p: ProjectPatch | Project): number {
  const v = (p as ProjectPatch).version;
  return typeof v === "number" ? v : versionOf(p.updated_at);
}

/** Is `next` not newer than `cur`? (An action's own answer may tie: it is
 * the newest word on that run.) Without versions on both sides, a
 * finished run never goes back to running. */
export function notNewer(cur: LiveRun | Conversion | null, next: LiveRun | Conversion, acceptTie = false): boolean {
  if (cur === null) return false;
  const a = versionOfRun(cur);
  const b = versionOfRun(next);
  if (Number.isFinite(a) && Number.isFinite(b)) return acceptTie ? b < a : b <= a;
  const done = cur.state !== undefined && RUN_TERMINAL.has(cur.state);
  return done && (next.state === undefined || !RUN_TERMINAL.has(next.state));
}

function addRunToProject(store: Store, projectId: string, conversionId: string): void {
  const at = projectRunIdsAtom(projectId);
  const ids = store.get(at);
  if (!ids.includes(conversionId)) store.set(at, [...ids, conversionId]);
}

/** A run from an event, a poll or an action's answer; false when it was
 * not newer than what we have. A read or an action's answer (no event
 * version) may tie: the same moment, said by the gateway itself. */
export function applyRun(store: Store, next: LiveRun | Conversion): boolean {
  const read = (next as LiveRun).version === undefined;
  const run: LiveRun = read ? runFromRead(next) : (next as LiveRun);
  const at = runAtom(run.conversion_id);
  const cur = store.get(at);
  if (notNewer(cur, run, read)) return false;
  store.set(at, cur ? { ...cur, ...run } : run);
  const pid = run.project_id ?? cur?.project_id;
  if (pid) addRunToProject(store, pid, run.conversion_id);
  return true;
}

/** A project's own fields; false when not newer. */
export function applyProject(store: Store, next: ProjectPatch | Project): boolean {
  const patch: ProjectPatch = (next as ProjectPatch).version === undefined ? projectFromRead(next) : (next as ProjectPatch);
  const at = liveProjectAtom(patch.project_id);
  const cur = store.get(at);
  if (cur !== null) {
    const a = versionOfProject(cur);
    const b = versionOfProject(patch);
    if (Number.isFinite(a) && Number.isFinite(b) && b <= a) return false;
  }
  store.set(at, cur ? { ...cur, ...patch } : patch);
  return true;
}

/** The runs a page read with its project (so the slow poll knows the
 * active ones even before the stream says anything). */
export function seedRuns(store: Store, runs: readonly Conversion[] | undefined): void {
  for (const r of runs ?? []) applyRun(store, r);
}

/** Runs we hold as still going. */
export function activeRunIds(store: Store): string[] {
  return [...runAtom.getParams()].filter((id) => {
    const r = store.get(runAtom(id));
    return r !== null && (r.state === undefined || !RUN_TERMINAL.has(r.state));
  });
}

/**
 * One event into the atoms. Returns the runs to read again: after a
 * snapshot, the ones we held as going that it didn't name (they may have
 * finished while we were away, beyond its newest 50).
 */
export function applyLiveEvent(store: Store, ev: LiveEvent): string[] {
  switch (ev.type) {
    case "snapshot": {
      const named = new Set(ev.runs.map((r) => r.conversion_id));
      const missing = activeRunIds(store).filter((id) => !named.has(id));
      for (const r of ev.runs) applyRun(store, r);
      for (const p of ev.projects) applyProject(store, p);
      for (const f of ev.formats ?? []) applyFormats(store, f);
      for (const h of ev.handoffs ?? []) applyHandoff(store, h);
      for (const x of ev.settles ?? []) applySettle(store, x);
      if (ev.balance) applyBalance(store, ev.balance);
      return missing;
    }
    case "run.state":
    case "run.progress":
      applyRun(store, ev.run);
      return [];
    case "project.updated":
      applyProject(store, ev.project);
      return [];
    case "run.formats":
      applyFormats(store, ev.formats);
      return [];
    case "handoff.state":
      applyHandoff(store, ev.handoff);
      return [];
    case "billing.updated":
      if (ev.settle) applySettle(store, ev.settle);
      if (ev.balance) applyBalance(store, ev.balance);
      return [];
    case "bye":
      return [];
  }
}

/** Format jobs; a snapshot's (stream-wide version) never wins a tie. */
export function applyFormats(store: Store, f: LiveFormats): void {
  const at = liveFormatsAtom(f.run_id);
  const cur = store.get(at);
  if (cur !== null && f.version <= cur.version) return;
  store.set(at, f);
}

export function applyHandoff(store: Store, h: LiveHandoff): void {
  const at = liveHandoffAtom(h.code);
  const cur = store.get(at);
  if (cur !== null && h.version <= cur.version) return;
  store.set(at, h);
}

export function applySettle(store: Store, x: LiveSettle): void {
  const at = liveSettleAtom(x.settle_id);
  const cur = store.get(at);
  if (cur !== null && x.version <= cur.version) return;
  store.set(at, x);
  if (x.version > store.get(billingVersionAtom)) store.set(billingVersionAtom, x.version);
}

export function applyBalance(store: Store, b: LiveBalance): void {
  const cur = store.get(liveBalanceAtom);
  if (cur !== null && b.version <= cur.version) return;
  store.set(liveBalanceAtom, b);
  if (b.version > store.get(billingVersionAtom)) store.set(billingVersionAtom, b.version);
}

/** A run with what the live feed knows on top, unless the page's copy is
 * newer (a tie goes to the feed: the page never edits a run itself). */
export function mergeRun(base: Conversion, live: LiveRun | null): Conversion {
  if (live === null || notNewer(base, live, true)) return base;
  const { version: _v, ...fields } = live;
  void _v;
  return { ...base, ...fields };
}

function fullRun(r: LiveRun | null): r is LiveRun & Conversion {
  return (
    r !== null &&
    typeof r.created_at === "string" &&
    typeof r.state === "string" &&
    r.quote !== undefined &&
    r.params !== undefined
  );
}

function newestFirst(a: { created_at: string }, b: { created_at: string }): number {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

/**
 * A project with the live feed on top: its own fields when newer, each
 * run merged, runs the page hasn't read yet added (a project read with
 * its runs), and a list item's card summary from its newest run.
 */
export function mergeProject(
  base: Project,
  patch: ProjectPatch | null,
  runIds: readonly string[],
  runFor: (id: string) => LiveRun | null,
): Project {
  let p = base;
  if (patch !== null) {
    const a = versionOfProject(base);
    const b = versionOfProject(patch);
    // only a strictly newer patch: the page's own read wins a tie (it may
    // carry an edit the feed's copy of the same moment doesn't)
    if (!(Number.isFinite(a) && Number.isFinite(b)) || b > a) {
      const { version: _v, deleted: _d, ...fields } = patch;
      void _v;
      void _d;
      p = { ...base, ...fields };
    }
  }
  if (base.conversions !== undefined) {
    const listed = new Set(base.conversions.map((c) => c.conversion_id));
    const merged = base.conversions.map((c) => mergeRun(c, runFor(c.conversion_id)));
    const added = runIds
      .filter((id) => !listed.has(id))
      .map(runFor)
      .filter(fullRun)
      .map(({ version: _v, ...r }) => {
        void _v;
        return r as Conversion;
      });
    p = { ...p, conversions: added.length > 0 ? [...added, ...merged].sort(newestFirst) : merged };
  } else if (p.summary !== undefined) {
    const newest = runIds.map(runFor).filter(fullRun).sort(newestFirst)[0];
    if (newest !== undefined) {
      p = {
        ...p,
        summary: {
          ...p.summary,
          latest_state: newest.state,
          latest_step: newest.step,
          latest_progress: newest.progress,
          latest_eta_seconds: newest.eta_seconds,
          latest_waiting_for_gpu: newest.waiting_for_gpu,
          latest_billing_status: newest.billing?.status,
        },
      };
    }
  }
  return p;
}

/** Is this project deleted, as the live feed last heard? */
export function liveDeleted(store: Store, projectId: string): boolean {
  return store.get(liveProjectAtom(projectId))?.deleted === true;
}

/** Forget everything live (sign-out, tests). */
export function resetLive(store: Store): void {
  for (const id of [...runAtom.getParams()]) runAtom.remove(id);
  for (const id of [...liveProjectAtom.getParams()]) liveProjectAtom.remove(id);
  for (const id of [...projectRunIdsAtom.getParams()]) projectRunIdsAtom.remove(id);
  for (const id of [...liveFormatsAtom.getParams()]) liveFormatsAtom.remove(id);
  for (const id of [...liveHandoffAtom.getParams()]) liveHandoffAtom.remove(id);
  for (const id of [...liveSettleAtom.getParams()]) liveSettleAtom.remove(id);
  store.set(liveBalanceAtom, null);
  store.set(billingVersionAtom, 0);
  store.set(fallbackTickAtom, 0);
  store.set(liveStatusAtom, "idle");
}
