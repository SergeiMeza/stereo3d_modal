"use client";

/**
 * Per-(project, step) checkout state that must SURVIVE tab navigation: the
 * workspace panels unmount on every tab switch (see lib/viewerPrefs), so an
 * in-flight conversion tracked with component-local state would vanish from
 * the UI the moment the user peeks at another tab — the job keeps running
 * (and billing), but the panel would re-offer "Convert" as if nothing were
 * happening.
 *
 * Held in jotai's DEFAULT store, module-scoped, exactly like viewerPrefs.
 * Deliberately NOT persisted to localStorage: the gateway already persists
 * every conversion in Firestore and returns them with GET /v1/projects/{id},
 * so a full page reload resumes from the server instead (useStepCheckout
 * adopts the newest still-running step conversion on mount). The server copy
 * is authoritative; a localStorage copy could only ever be stale.
 */

import { atom, type PrimitiveAtom } from "jotai";

import type { Conversion, Step, StepQuoteResponse } from "@/lib/api/types";

export interface StepCheckoutState {
  /** Priced quote for the panel's current params. */
  quote: StepQuoteResponse | null;
  /** Idempotency-Key, stable per attempt (minted on the first Convert
   * click, cleared with the quote) — survives navigation with the quote so
   * a retry after a tab round-trip still can't double-charge. */
  attemptKey: string | null;
  /** The conversion being tracked (running, or terminal with the tracker
   * still mounted). */
  active: Conversion | null;
  /** active reached a terminal state. */
  settled: boolean;
}

export const EMPTY_CHECKOUT: StepCheckoutState = {
  quote: null,
  attemptKey: null,
  active: null,
  settled: false,
};

const atoms = new Map<string, PrimitiveAtom<StepCheckoutState>>();

/** The surviving checkout state for one (project, step) panel. */
export function stepCheckoutAtom(
  projectId: string,
  step: Step,
): PrimitiveAtom<StepCheckoutState> {
  const key = `${projectId}/${step}`;
  let a = atoms.get(key);
  if (a === undefined) {
    a = atom<StepCheckoutState>(EMPTY_CHECKOUT);
    atoms.set(key, a);
  }
  return a;
}

/** Test hook (vitest.setup.ts afterEach): forget every panel's state. The
 * old atoms become unreachable, so their default-store values go with them. */
export function resetStepCheckoutState(): void {
  atoms.clear();
}
