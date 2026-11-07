/**
 * The app's one live stream owner (owner 2026-11-07): a single
 * LiveConnection for the signed-in user, kept while anything retains it
 * (the layout's LiveEvents for the whole session; a screen that shows a
 * status also retains it, so a screen rendered on its own still updates).
 * It closes while the page is hidden and reconnects when it's shown, and
 * everything live is forgotten when the user changes.
 */

import type { GatewayClient } from "@/lib/api/client";
import { appStore } from "@/lib/state/stores";

import { FALLBACK_POLL_MS, LiveConnection, type LiveOptions, type LiveTransport } from "./connection";
import { activeRunIds, applyProject, applyRun, openProjectsAtom, resetLive } from "./liveStore";

type Client = Pick<GatewayClient, "openEvents" | "getConversion" | "getProject" | "listProjects">;

/** The slow poll while the stream is down: the runs we hold as going,
 * the project list, and the project pages open now. */
export async function pollOnce(client: Client, store = appStore): Promise<void> {
  const runs = activeRunIds(store).map((id) =>
    client.getConversion(id).then(
      (r) => void applyRun(store, r),
      () => undefined,
    ),
  );
  const list = client.listProjects().then(
    (res) => {
      for (const p of res?.projects ?? []) applyProject(store, p);
    },
    () => undefined,
  );
  const open = [...store.get(openProjectsAtom).keys()].map((id) =>
    client.getProject(id).then(
      (p) => {
        applyProject(store, p);
        for (const r of p.conversions ?? []) applyRun(store, r);
      },
      () => undefined,
    ),
  );
  await Promise.all([...runs, list, ...open]);
}

export function transportFor(client: Client, store = appStore): LiveTransport {
  return {
    open: (lastId, signal) => client.openEvents(lastId, signal),
    poll: () => pollOnce(client, store),
    resync: async (ids) => {
      await Promise.all(
        ids.map((id) =>
          client.getConversion(id).then(
            (r) => void applyRun(store, r),
            () => undefined,
          ),
        ),
      );
    },
  };
}

let conn: LiveConnection | null = null;
let owner: string | null = null;
let holds = 0;
let idle: ReturnType<typeof setTimeout> | null = null;
let unbind: (() => void) | null = null;
/** test hook: options for the next connection */
let nextOptions: LiveOptions = {};

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function bindVisibility(): void {
  if (unbind !== null || typeof document === "undefined") return;
  const onChange = () => {
    if (conn === null) return;
    if (hidden()) conn.pause();
    else if (holds > 0) conn.start();
  };
  document.addEventListener("visibilitychange", onChange);
  unbind = () => document.removeEventListener("visibilitychange", onChange);
}

/** Keep the stream open for this user; returns the release. */
export function retainLive(uid: string, client: Client): () => void {
  if (owner !== uid) {
    conn?.stop();
    if (owner !== null) resetLive(appStore);
    owner = uid;
    conn = new LiveConnection(appStore, transportFor(client), nextOptions);
  }
  if (idle !== null) clearTimeout(idle);
  idle = null;
  holds += 1;
  bindVisibility();
  if (!hidden()) conn?.start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    // nothing shows a status any more: close soon (a tab switch remounts
    // its screens within the same moment, so it doesn't reconnect)
    if (holds === 0) {
      idle = setTimeout(() => {
        idle = null;
        if (holds === 0) conn?.stop();
      }, IDLE_CLOSE_MS);
    }
  };
}

/** How long the stream stays open after the last screen let it go. */
export const IDLE_CLOSE_MS = 1000;

/** Close the stream and forget everything live (sign-out). */
export function stopLive(): void {
  if (idle !== null) clearTimeout(idle);
  idle = null;
  conn?.stop();
  conn = null;
  if (owner !== null) resetLive(appStore);
  owner = null;
  holds = 0;
  unbind?.();
  unbind = null;
}

/** The project pages open now (the slow poll reads them again). */
export function retainOpenProject(projectId: string): () => void {
  appStore.set(openProjectsAtom, (m) => new Map(m).set(projectId, (m.get(projectId) ?? 0) + 1));
  return () =>
    appStore.set(openProjectsAtom, (m) => {
      const next = new Map(m);
      const n = (next.get(projectId) ?? 1) - 1;
      if (n <= 0) next.delete(projectId);
      else next.set(projectId, n);
      return next;
    });
}

/** Test hook: the live connection now (null when closed). */
export function liveConnectionForTests(): LiveConnection | null {
  return conn;
}

/** Test hook: options for connections made from now on. */
export function setLiveOptionsForTests(o: LiveOptions): void {
  nextOptions = o;
}

/** Test hook: close and forget everything. */
export function resetLiveHubForTests(): void {
  stopLive();
  nextOptions = {};
  appStore.set(openProjectsAtom, new Map());
}

export { FALLBACK_POLL_MS };
