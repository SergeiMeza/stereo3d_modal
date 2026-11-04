"use client";

/**
 * Where atoms live (ADR 0138).
 *
 * - The APP store (jotai's default store) holds what the whole session
 *   shares: the account's billing, the viewer prefs, the price epoch.
 *   Read those with the `useApp*` hooks, so a project page's own store
 *   never shadows them.
 * - Each project page gets its OWN store (ProjectStateProvider, keyed by
 *   the project id): the project, its runs, the checkout, Make 3D's
 *   picks and the side prices. Opening another project starts clean; the
 *   tabs inside one project share it (the panels unmount on every tab
 *   switch, the store doesn't).
 *
 * Nothing secret goes in an atom (no tokens, no client secrets kept past
 * their sheet), and nothing here is persisted.
 */

import { createStore, Provider, useAtom, useAtomValue, useSetAtom, getDefaultStore } from "jotai";
import type { Atom, WritableAtom } from "jotai";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { openProjectIdAtom } from "./projectScope";

type Store = ReturnType<typeof createStore>;

/** The session's store (jotai's default store). */
export const appStore: Store = getDefaultStore();

const projectStores = new Set<Store>();

/** Run `fn` on the app store and every open project page's store. */
export function forEachStore(fn: (store: Store) => void): void {
  fn(appStore);
  for (const s of projectStores) fn(s);
}

/** A fresh store for one project page (mount it with key={projectId}). */
export function ProjectStateProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}): ReactNode {
  const [store] = useState(() => {
    const s = createStore();
    s.set(openProjectIdAtom, projectId);
    return s;
  });
  useEffect(() => {
    projectStores.add(store);
    return () => {
      projectStores.delete(store);
    };
  }, [store]);
  return <Provider store={store}>{children}</Provider>;
}

const APP = { store: appStore };

/** An app-store atom's value (session-wide state). */
export function useAppAtomValue<V>(a: Atom<V>): V {
  return useAtomValue(a, APP);
}

/** An app-store atom as [value, set]. */
export function useAppAtom<V, Args extends unknown[], R>(
  a: WritableAtom<V, Args, R>,
): [V, (...args: Args) => R] {
  return useAtom(a, APP);
}

/** An app-store atom's setter. */
export function useAppSetAtom<V, Args extends unknown[], R>(
  a: WritableAtom<V, Args, R>,
): (...args: Args) => R {
  return useSetAtom(a, APP);
}
