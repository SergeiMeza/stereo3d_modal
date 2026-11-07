/**
 * The console's live runs (owner 2026-11-07, gateway 4578628): GET
 * /v1/admin/events?ticket=&uid= (or run_id=, feed=active), runs only:
 * snapshot, run.state, run.progress and bye. One EventSource per view; a
 * ticket lasts two minutes and covers EventSource's own reconnects, so
 * once one closes for good a fresh ticket opens a new stream (backoff with
 * jitter, 2 s to 30 s). Closed while the page is hidden. Each run keeps
 * the highest version seen; anything not higher is dropped.
 */

import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { getDefaultStore } from "jotai";

import type { AdminApi } from "./api";

/** A run as the stream said it (the GET /v1/conversions/{id} shape, or
 * only its progress fields). */
export interface LiveAdminRun {
  conversion_id: string;
  version: number;
  state?: string;
  progress?: number;
  stage?: string;
  eta_seconds?: number;
  waiting_for_gpu?: boolean;
  created_at?: string;
  step?: string;
  method?: string;
  quote?: { amount_cents?: number };
  [k: string]: unknown;
}

export const liveAdminRunAtom = atomFamily((id: string) => {
  void id;
  return atom<LiveAdminRun | null>(null);
});

/** The runs the stream named for an account (newest first). */
export const liveAccountRunIdsAtom = atomFamily((uid: string) => {
  void uid;
  return atom<string[]>([]);
});

type Store = ReturnType<typeof getDefaultStore>;

function micros(at: unknown): number {
  if (typeof at !== "string") return 0;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms * 1000 : 0;
}

/** One run into its atom; false when not newer. */
export function applyAdminRun(store: Store, run: LiveAdminRun, uid?: string): boolean {
  const at = liveAdminRunAtom(run.conversion_id);
  const cur = store.get(at);
  if (cur !== null && run.version <= cur.version) return false;
  store.set(at, cur ? { ...cur, ...run } : run);
  if (uid) {
    const ids = liveAccountRunIdsAtom(uid);
    const list = store.get(ids);
    if (!list.includes(run.conversion_id)) store.set(ids, [run.conversion_id, ...list]);
  }
  return true;
}

/** One SSE message into the atoms. */
export function applyAdminEvent(store: Store, event: string, data: string, uid?: string): void {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  const version = typeof body.version === "number" ? body.version : 0;
  if (event === "snapshot") {
    const runs = Array.isArray(body.runs) ? (body.runs as Record<string, unknown>[]) : [];
    // newest first: apply oldest first so the list keeps that order
    for (const r of [...runs].reverse()) {
      if (typeof r.conversion_id !== "string") continue;
      applyAdminRun(store, { ...r, conversion_id: r.conversion_id, version: micros(r.updated_at) || version }, uid);
    }
  } else if (event === "run.state") {
    const run = (body.run ?? {}) as Record<string, unknown>;
    const id = typeof body.run_id === "string" ? body.run_id : run.conversion_id;
    if (typeof id !== "string") return;
    applyAdminRun(store, { ...run, conversion_id: id, state: (body.state as string) ?? (run.state as string), version }, uid);
  } else if (event === "run.progress") {
    if (typeof body.run_id !== "string") return;
    const fields = Object.fromEntries(
      ["state", "progress", "stage", "eta_seconds", "waiting_for_gpu", "queued_s"]
        .filter((k) => body[k] !== undefined && body[k] !== null)
        .map((k) => [k, body[k]]),
    );
    applyAdminRun(store, { conversion_id: body.run_id, version, ...fields }, uid);
  }
}

export interface StreamOptions {
  /** what to watch: one account's runs, one run, or every going run */
  scope: { uid: string } | { run_id: string } | { feed: "active" };
  store?: Store;
  /** tests: the EventSource class */
  EventSourceImpl?: typeof EventSource;
  random?: () => number;
}

/** Open the console stream; returns the close. Nothing happens where
 * the browser has no EventSource. */
export function openAdminRunStream(api: Pick<AdminApi, "eventsTicket" | "urlOf">, o: StreamOptions): () => void {
  const ES = o.EventSourceImpl ?? (typeof EventSource === "undefined" ? undefined : EventSource);
  if (!ES) return () => {};
  const store = o.store ?? getDefaultStore();
  const uid = "uid" in o.scope ? o.scope.uid : undefined;
  const query = new URLSearchParams(o.scope as Record<string, string>).toString();
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;
  let lastId: string | null = null;

  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

  const stop = () => {
    es?.close();
    es = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const retry = () => {
    if (closed || hidden()) return;
    const step = Math.min(30_000, 2000 * 2 ** attempt);
    attempt += 1;
    timer = setTimeout(() => void connect(), Math.round(step / 2 + ((o.random ?? Math.random)() * step) / 2));
  };

  const connect = async () => {
    timer = null;
    if (closed || hidden()) return;
    let url: string;
    try {
      const t = await api.eventsTicket();
      url = api.urlOf(`${t.url}&${query}${lastId ? `&last_event_id=${encodeURIComponent(lastId)}` : ""}`);
    } catch {
      retry();
      return;
    }
    if (closed || hidden()) return;
    const source = new ES(url);
    es = source;
    const on = (name: string) =>
      source.addEventListener(name, (e) => {
        const m = e as MessageEvent<string>;
        if (m.lastEventId) lastId = m.lastEventId;
        attempt = 0;
        applyAdminEvent(store, name, m.data, uid);
      });
    on("snapshot");
    on("run.state");
    on("run.progress");
    source.addEventListener("bye", () => {
      // the server's goodbye: a fresh ticket, straight away
      source.close();
      if (es === source) es = null;
      void connect();
    });
    source.onerror = () => {
      // EventSource retries by itself while the ticket lasts; once it gives
      // up, a new ticket
      if (source.readyState === 2) {
        if (es === source) es = null;
        retry();
      }
    };
  };

  const onVisible = () => {
    if (hidden()) stop();
    else if (es === null && timer === null) void connect();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  void connect();
  return () => {
    closed = true;
    stop();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}
