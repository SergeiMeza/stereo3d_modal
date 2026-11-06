/**
 * Which past preview "Your preview" shows (owner 2026-11-07), per project
 * in the project page's store (ADR 0138). null shows the latest finished
 * one. A pick remembers which run was newest when it was made: once a new
 * preview starts, the pick lapses and the panel follows the new one.
 * Kept free of UI imports (the test setup loads it).
 */

import { atom } from "jotai";
import { atomFamily } from "jotai-family";

export interface PastPreviewPick {
  /** the picked preview's conversion id */
  id: string;
  /** the newest preview's id when it was picked */
  newestAtPick: string | null;
}

export const pastPreviewPickAtom = atomFamily((projectId: string) => {
  void projectId;
  return atom<PastPreviewPick | null>(null);
});

/** Test hook: forget every project's pick. */
export function resetPastPreviewsForTests(): void {
  for (const id of [...pastPreviewPickAtom.getParams()]) pastPreviewPickAtom.remove(id);
}
