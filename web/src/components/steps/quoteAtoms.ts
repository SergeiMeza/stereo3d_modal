"use client";

/**
 * The run's price (ADR 0138; staging bugs 2026-11-05): one checkout atom
 * per panel (checkoutStore) holds the quote, the request it answers, the
 * request being priced and why the last one failed. These action atoms
 * are the only writers, so the price box, QuoteView, the Make 3D button
 * and the pay sheet read one state and can't disagree:
 *
 * - latest wins: every request takes a number, and an answer whose number
 *   isn't current any more (a newer request, a change, a price change) is
 *   dropped;
 * - a request with no answer in 10 s fails with QUOTE_TIMED_OUT (Retry);
 * - the shown price is the quote only when it answers the request the
 *   panel shows now (`quoteView`), "Updating…" otherwise;
 * - useAutoQuote prices the panel's request 250 ms after it settles, also
 *   while a run is going.
 *
 * The gateway client is an argument of the action, never stored.
 */

import { atom, useAtomValue, useSetAtom, type PrimitiveAtom } from "jotai";
import { useEffect, useLayoutEffect, useRef } from "react";

import type { GatewayClient } from "@/lib/api/client";
import type { StepConversionRequest, StepQuoteResponse } from "@/lib/api/types";
import { track } from "@/lib/analytics";

import type { StepCheckoutState } from "./checkoutStore";

export const QUOTE_TIMEOUT_MS = 10_000;
export const QUOTE_TIMED_OUT = "Pricing is taking longer than usual.";
/** changes settle this long before they're priced */
export const QUOTE_DEBOUNCE_MS = 250;

type Scope = PrimitiveAtom<StepCheckoutState>;
type Quoter = Pick<GatewayClient, "quoteStep">;

/** Price `req` for the panel; the answer counts only while it's the latest. */
export const requestQuoteAtom = atom(
  null,
  async (
    get,
    set,
    a: {
      scope: Scope;
      client: Quoter;
      projectId: string;
      req: StepConversionRequest;
      /** an automatic re-quote leaves a finished run's tracker */
      keepTracker?: boolean;
      /** the error's words (the panel's copy for gateway codes) */
      describe: (e: unknown) => string;
    },
  ): Promise<void> => {
    const key = JSON.stringify(a.req);
    const mine = (get(a.scope).seq ?? 0) + 1;
    set(a.scope, (s) => ({ ...s, seq: mine, pendingKey: key, quoteError: null, error: null, billingBlock: null }));
    const current = () => (get(a.scope).seq ?? 0) === mine;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        a.client.quoteStep(a.projectId, a.req),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(QUOTE_TIMED_OUT)), QUOTE_TIMEOUT_MS);
        }),
      ]);
      if (!current()) return;
      track("quote_received", { step: a.req.step, value: res.quote.amount_cents / 100, currency: "USD" });
      set(a.scope, (s) => ({
        ...s,
        quote: res,
        quoteKey: key,
        previous: res,
        attemptKey: null, // a fresh quote is a fresh attempt
        pendingKey: null,
        // a finished run's tracker goes before a new attempt
        ...(s.settled && !a.keepTracker ? { active: null, settled: false } : {}),
      }));
    } catch (e) {
      if (current()) set(a.scope, (s) => ({ ...s, pendingKey: null, quoteError: a.describe(e) }));
    } finally {
      clearTimeout(timer);
    }
  },
);

/** A priced input changed: the quote (and any answer on its way) is stale,
 * and so is the attempt key. The last quote stays as `previous`. */
export const invalidateQuoteAtom = atom(null, (_get, set, scope: Scope) => {
  set(scope, (s) => ({
    ...s,
    seq: (s.seq ?? 0) + 1,
    pendingKey: null,
    quote: null,
    previous: s.quote ?? s.previous ?? null,
    attemptKey: null,
  }));
});

/** The panel's request now, so every reader judges the quote against it. */
export const wantQuoteAtom = atom(null, (_get, set, a: { scope: Scope; key: string }) => {
  set(a.scope, (s) => (s.wantKey === a.key ? s : { ...s, wantKey: a.key }));
});

export interface QuoteView {
  /** the quote, only when it answers `key` */
  quote: StepQuoteResponse | null;
  /** the last quote received, also while a change re-prices */
  last: StepQuoteResponse | null;
  /** `key` is being priced */
  quoting: boolean;
  /** a newer request than the last price is on its way or waiting */
  updating: boolean;
  /** why pricing `key` failed */
  error: string | null;
}

/** What one panel shows for the request `key` (undefined: the panel's
 * own `wantKey`). A quote without a key (set elsewhere) counts as fresh. */
export function quoteView(s: StepCheckoutState, key?: string): QuoteView {
  const want = key ?? s.wantKey;
  const fresh =
    s.quote !== null && (s.quoteKey === undefined || want === undefined || s.quoteKey === want);
  const last = s.quote ?? s.previous ?? null;
  return {
    quote: fresh ? s.quote : null,
    last,
    quoting: s.pendingKey !== null && s.pendingKey !== undefined && (want === undefined || s.pendingKey === want),
    updating: !fresh && last !== null,
    error: fresh ? null : (s.quoteError ?? null),
  };
}

/**
 * Keeps the panel's request priced: tells the atom which request shows
 * (before paint), then asks for its price `QUOTE_DEBOUNCE_MS` after the
 * last change, unless it's priced, on its way, stopped, or just failed
 * (Retry asks again).
 */
export function useAutoQuote(a: {
  scope: Scope;
  key: string;
  stop: boolean;
  quote: (req: StepConversionRequest) => void;
}): void {
  const s = useAtomValue(a.scope);
  const want = useSetAtom(wantQuoteAtom);
  const failedKey = useRef<string | null>(null);
  const { scope, key, stop } = a;
  useLayoutEffect(() => {
    want({ scope, key });
  }, [want, scope, key]);
  const view = quoteView(s, key);
  const priced = view.quote !== null;
  const asking = s.pendingKey === key;
  const failed = view.error !== null;
  const quoteRef = useRef(a.quote);
  useEffect(() => {
    quoteRef.current = a.quote;
  });
  useEffect(() => {
    if (stop || priced || asking) return;
    // a failed quote waits for a change or Retry instead of looping
    if (failed && failedKey.current === key) return;
    const t = setTimeout(() => {
      failedKey.current = key;
      quoteRef.current(JSON.parse(key) as StepConversionRequest);
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key, stop, priced, asking, failed]);
}
