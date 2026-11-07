"use client";

/**
 * Server data read once and shared (ADR 0138): one app-store atom per
 * resource with its answer, so every reader shows the same thing and a
 * page's useState never holds a fetch result. The fetch runs on a
 * reader's mount unless an answer is in or on its way; a failed one is
 * tried again on the next mount. The fetch is passed in (it carries the
 * gateway client), never stored.
 */

import { atom } from "jotai";
import { useEffect, useRef } from "react";

import { appStore, useAppAtomValue } from "./stores";

type Status = "idle" | "loading" | "done" | "error";

export interface SharedFetch<T> {
  /** the answer, null until it's in (or when it failed) */
  use: (fetcher: () => Promise<T>) => T | null;
  /** test hook: forget the answer */
  reset: () => void;
  /** read it again (the current answer stays until the new one is in);
   * any mounted reader fetches */
  refresh: () => void;
}

export function sharedFetch<T>(): SharedFetch<T> {
  const state = atom<{ status: Status; value: T | null }>({ status: "idle", value: null });
  const load = atom(null, async (get, set, fetcher: () => Promise<T>) => {
    const s = get(state);
    if (s.status === "loading" || s.status === "done") return;
    set(state, { status: "loading", value: s.value });
    try {
      set(state, { status: "done", value: await fetcher() });
    } catch {
      set(state, { status: "error", value: null });
    }
  });
  return {
    use(fetcher) {
      const s = useAppAtomValue(state);
      const ref = useRef(fetcher);
      useEffect(() => {
        ref.current = fetcher;
      });
      // on mount (a failed answer is tried again then)
      useEffect(() => {
        void appStore.set(load, () => ref.current());
      }, []);
      // and after refresh() (idle again, the answer kept meanwhile)
      useEffect(() => {
        if (s.status === "idle") void appStore.set(load, () => ref.current());
      }, [s.status]);
      return s.value;
    },
    reset() {
      appStore.set(state, { status: "idle", value: null });
    },
    refresh() {
      const s = appStore.get(state);
      if (s.status === "loading") return;
      appStore.set(state, { status: "idle", value: s.value });
    },
  };
}
