/**
 * A finished run's files and its other formats (ADR 0138: atoms per run in
 * the project page's store, not useState copies). RunFiles writes the
 * files it read (GET .../downloads), AnotherFormat the format jobs (GET
 * /v1/runs/{id}/formats) and when it read them, so a pending row can count
 * down from the gateway's remaining time. Kept free of UI imports (the
 * test setup loads it).
 */

import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import type { DownloadFile, Format, RunFormats } from "@/lib/api/types";

export interface RunFilesState {
  files: DownloadFile[] | null;
  /** when the signed links run out (ms) */
  expiresAt: number;
  error: string | null;
}

export const runFilesAtom = atomFamily((runId: string) => {
  void runId;
  return atom<RunFilesState>({ files: null, expiresAt: 0, error: null });
});

export interface RunFormatsState {
  data: RunFormats | null;
  /** when `data` was read (ms), for the remaining-time countdown */
  readAt: number;
  /** the POST's estimate and when it was asked, until the GET carries one */
  started: Partial<Record<Format, { at: number; seconds: number | null }>>;
}

export const runFormatsAtom = atomFamily((runId: string) => {
  void runId;
  return atom<RunFormatsState>({ data: null, readAt: 0, started: {} });
});

/** Test hook: forget every run's files and formats. */
export function resetRunFilesForTests(): void {
  for (const id of [...runFilesAtom.getParams()]) runFilesAtom.remove(id);
  for (const id of [...runFormatsAtom.getParams()]) runFormatsAtom.remove(id);
}
