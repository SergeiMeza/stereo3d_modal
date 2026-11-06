/**
 * Make 3D's Previous runs (owner 2026-11-07): whether the whole list is
 * open, per project in the project page's store (ADR 0138). Shared so the
 * "You already made this" note by the button can open the list on the
 * run it names. Kept free of UI imports (the test setup loads it).
 */

import { atom } from "jotai";
import { atomFamily } from "jotai-family";

export const previousRunsOpenAtom = atomFamily((projectId: string) => {
  void projectId;
  return atom(false);
});

/** Test hook: close every project's list. */
export function resetPreviousRunsForTests(): void {
  for (const id of [...previousRunsOpenAtom.getParams()]) previousRunsOpenAtom.remove(id);
}
