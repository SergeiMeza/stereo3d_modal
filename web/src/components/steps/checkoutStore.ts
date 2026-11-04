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

import { atom, getDefaultStore, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai-family";

import type {
  Conversion,
  Method,
  Step,
  StepQuoteResponse,
} from "@/lib/api/types";

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
  /** staging 2026-11-05: the request `quote` answers (JSON), so a panel
   * never shows a price for other selections; absent when set elsewhere */
  quoteKey?: string;
  /** the last quote received, kept while a change re-prices (its plan
   * tier and split offer stay steady instead of flickering) */
  previous?: StepQuoteResponse | null;
  /** ADR 0138: the request the panel shows now (JSON); a quote counts as
   * the price only when it answers this one */
  wantKey?: string;
  /** the request being priced now (JSON) */
  pendingKey?: string | null;
  /** why the last quote failed (timeout included); cleared by the next */
  quoteError?: string | null;
  /** latest-wins counter: an answer whose number isn't current is dropped */
  seq?: number;
  /** why the last Make 3D (convert) failed */
  error?: string | null;
  /** a 402 the convert hit (no method, overdue, declined) */
  billingBlock?: BillingBlock | null;
  /** a run waiting for its payment: the pay sheet is open (P1/P3) */
  payNow?: Conversion | null;
}

/** 402 gate codes the panels route on (lib/api/types.ts APIErrorBody). */
export type BillingBlock =
  | "no_payment_method"
  | "billing_overdue"
  | "card_declined";

export const EMPTY_CHECKOUT: StepCheckoutState = {
  quote: null,
  attemptKey: null,
  active: null,
  settled: false,
};

/** ADR 0138: one checkout atom per "project/method/step". */
const checkoutFamily = atomFamily((key: string) => {
  void key;
  return atom<StepCheckoutState>(EMPTY_CHECKOUT);
});

/** The surviving checkout state for one (project, step) panel. Both
 * methods have a production page, so it is keyed by method too — a
 * Lifelike run in flight never shows up on the Classic page. */
export function stepCheckoutAtom(
  projectId: string,
  step: Step,
  method: Method = "classic",
): PrimitiveAtom<StepCheckoutState> {
  const key =
    method === "classic"
      ? `${projectId}/${step}`
      : `${projectId}/${method}/${step}`;
  return checkoutFamily(key);
}

/** Test hook (vitest.setup.ts afterEach): forget every panel's state. The
 * old atoms become unreachable, so their default-store values go with them. */
export function resetStepCheckoutState(): void {
  for (const k of [...checkoutFamily.getParams()]) checkoutFamily.remove(k);
}

/** Bumped whenever prices change for this account (Pro bought or ended):
 * the tile price hooks (makeControls) key their quotes on it. */
export const priceEpochAtom = atom(0);

/** Drop every panel's priced quote (S3D-68: Pro just changed, so prices
 * did too). A panel with no quote asks for a new one, and the attempt key
 * goes with the quote, as invalidate() does. Runs in flight are untouched. */
export function clearStepQuotes(): void {
  const store = getDefaultStore();
  // the quality and edge tiles price again too (their own quotes)
  store.set(priceEpochAtom, (n) => n + 1);
  for (const k of checkoutFamily.getParams()) {
    const a = checkoutFamily(k);
    const s = store.get(a);
    if (s.quote !== null || s.attemptKey !== null || s.pendingKey) {
      // an answer still on its way was priced before the change: dropped
      store.set(a, {
        ...s,
        quote: null,
        previous: s.quote ?? s.previous ?? null,
        attemptKey: null,
        pendingKey: null,
        seq: (s.seq ?? 0) + 1,
      });
    }
  }
}
