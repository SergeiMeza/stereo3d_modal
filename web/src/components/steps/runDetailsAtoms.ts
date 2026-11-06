/**
 * Files' Details panels (owner 2026-11-07), in the project page's store
 * (ADR 0138): which runs have theirs open (one atom per run, so opening
 * one leaves the others alone), and the receipts read from the purchases
 * list (GET /v1/billing/history?filter=runs, first page), by run.
 * Kept free of UI imports (the test setup loads it).
 */

import { atom, getDefaultStore } from "jotai";
import { atomFamily } from "jotai-family";

export const runDetailsOpenAtom = atomFamily((conversionId: string) => {
  void conversionId;
  return atom(false);
});

export interface RunReceipts {
  state: "idle" | "loading" | "loaded";
  /** run id → its receipt (or invoice) page */
  urls: Record<string, string>;
}

export const runReceiptsAtom = atom<RunReceipts>({ state: "idle", urls: {} });

/** Test hook: close every panel and forget the receipts. */
export function resetRunDetailsForTests(): void {
  for (const id of [...runDetailsOpenAtom.getParams()]) runDetailsOpenAtom.remove(id);
  getDefaultStore().set(runReceiptsAtom, { state: "idle", urls: {} });
}
