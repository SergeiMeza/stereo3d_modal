/**
 * Runs as their trackers last polled them (ADR 0138): one atom per run in
 * the project page's store, so a remount (a tab switch) and every reader
 * see the same state. Kept free of UI imports (the test setup loads it).
 */

import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import type { Conversion } from "@/lib/api/types";

/** One run as its tracker last polled it (null until the first answer). */
export const conversionAtom = atomFamily((conversionId: string) => {
  void conversionId;
  return atom<Conversion | null>(null);
});

/** Test hook: forget every polled run. */
export function resetConversionsForTests(): void {
  for (const id of [...conversionAtom.getParams()]) conversionAtom.remove(id);
}
