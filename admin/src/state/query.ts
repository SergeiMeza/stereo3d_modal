import { atom, useAtomValue, useSetAtom, type Getter } from "jotai";
import { atomFamily } from "jotai-family";
import { useCallback, useEffect } from "react";

import { ApiError } from "@/lib/api";

/**
 * Gateway responses live in atoms (ADR 0138). A query is one atom per
 * params key (jotai-family), holding what's on screen for it:
 *
 * - latest wins: each load takes a sequence number, and an answer that
 *   isn't the newest for its key is dropped;
 * - a timeout (20 s by default) ends in an error with Retry, so nothing
 *   loads forever;
 * - `reload` keeps the current data on screen while it fetches, `set`
 *   replaces it with an action's answer (or an update of it).
 *
 * The atoms are memory only: never persisted, and the gateway's session
 * token is not in them (it stays in AdminSession).
 */

export type Load<T> =
  | { kind: "loading" }
  /** `data`: what was on screen before a failed reload, if anything */
  | { kind: "error"; error: unknown; data?: T }
  | { kind: "loaded"; data: T };

interface Slot<T> {
  load: Load<T> | null;
  seq: number;
}

export const QUERY_TIMEOUT_MS = 20_000;

export class QueryTimeout extends ApiError {
  constructor() {
    super(504, "timeout", "The gateway didn't answer in time. Try again.");
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new QueryTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** The last data a load holds: loaded, or kept through a failed reload. */
export function dataOf<T>(load: Load<T> | null | undefined): T | undefined {
  return load && load.kind !== "loading" ? load.data : undefined;
}

export function keyOf(params: unknown): string {
  return params === undefined ? "" : JSON.stringify(params);
}

export function createQuery<P, T>(fetcher: (get: Getter, params: P) => Promise<T>, opts: { timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? QUERY_TIMEOUT_MS;
  const slots = atomFamily((_key: string) => atom<Slot<T>>({ load: null, seq: 0 }));

  /**
   * Loads params. "keep" leaves the current data on screen meanwhile;
   * "revisit" keeps it only when it loaded (coming back to a screen shows
   * the last answer while it refreshes, a failed one shows the skeleton).
   */
  const run = atom(null, async (get, set, params: P, mode: "fresh" | "keep" | "revisit" = "fresh"): Promise<T> => {
    const slot = slots(keyOf(params));
    const seq = get(slot).seq + 1;
    const prev = get(slot).load;
    const keep = mode === "keep" || (mode === "revisit" && prev?.kind === "loaded");
    set(slot, { seq, load: keep ? prev : { kind: "loading" } });
    try {
      const data = await withTimeout(fetcher(get, params), timeoutMs);
      if (get(slot).seq === seq) set(slot, { seq, load: { kind: "loaded", data } });
      return data;
    } catch (error) {
      if (get(slot).seq === seq) {
        const prev = get(slot).load;
        const data = prev && prev.kind !== "loading" ? prev.data : undefined;
        set(slot, { seq, load: { kind: "error", error, data } });
      }
      throw error;
    }
  });

  /** Replaces the data (an action's answer); any load in flight loses. */
  const put = atom(null, (get, set, params: P, update: T | ((prev: T | undefined) => T)) => {
    const slot = slots(keyOf(params));
    const cur = get(slot);
    const prev = cur.load?.kind === "loaded" ? cur.load.data : undefined;
    const data = typeof update === "function" ? (update as (p: T | undefined) => T)(prev) : update;
    set(slot, { seq: cur.seq + 1, load: { kind: "loaded", data } });
  });

  /** Changes loaded data in place (a new grant, an older page of runs);
   * nothing happens when it hasn't loaded. Any load in flight loses. */
  const update = atom(null, (get, set, params: P, fn: (prev: T) => T) => {
    const slot = slots(keyOf(params));
    const cur = get(slot);
    if (cur.load?.kind !== "loaded") return;
    set(slot, { seq: cur.seq + 1, load: { kind: "loaded", data: fn(cur.load.data) } });
  });

  /** The load for params, for derived atoms (one memoized atom per key). */
  const values = atomFamily((key: string) => atom((get) => get(slots(key)).load));
  const value = (params: P) => values(keyOf(params));

  return { slots, run, put, update, value };
}

export type Query<P, T> = ReturnType<typeof createQuery<P, T>>;

/**
 * Reads a query for params and loads it when the params change (and when
 * `enabled` turns on). Replaces the old useState-based useLoad.
 */
export function useQuery<P, T>(q: Query<P, T>, params: P, enabled = true) {
  const key = keyOf(params);
  const slot = useAtomValue(q.slots(key));
  const run = useSetAtom(q.run);
  const put = useSetAtom(q.put);
  useEffect(() => {
    if (enabled) run(params, "revisit").catch(() => {});
    // params are compared by key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, run]);
  const retry = useCallback(() => void run(params).catch(() => {}), [key, run]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => run(params, "keep"), [key, run]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback((u: T | ((prev: T | undefined) => T)) => put(params, u), [key, put]); // eslint-disable-line react-hooks/exhaustive-deps
  const state: Load<T> = slot.load ?? { kind: "loading" };
  return { state, retry, reload, set };
}
