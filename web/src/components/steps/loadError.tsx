"use client";

/**
 * What a failed load says (loadErrorText), and whether this page is the
 * finished sample: read from the open project's atom (ADR 0138), so the
 * run files, earlier runs and the run tracker need no provider.
 */

import { useAtomValue } from "jotai";

import { isSampleAtom } from "@/components/workspace/workspaceAtoms";

export { loadErrorText, SAMPLE_UNAVAILABLE } from "./loadErrorText";

export function useIsSample(): boolean {
  return useAtomValue(isSampleAtom);
}
