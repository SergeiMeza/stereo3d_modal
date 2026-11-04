"use client";

/**
 * Side prices (ADR 0138, owner 2026-11-05): the quality cards, the edge
 * styles and the frame rates each show this video's price for one variant
 * of the run. Every variant is one quote, cached in an atom per (project,
 * request): a change that asks for a price already asked for (or still on
 * its way) sends nothing, so a change no longer fires a burst of repeats,
 * and a reader only ever looks up the requests of its current selections,
 * so an older answer landing late can't show (latest wins by key).
 *
 * The gateway client is passed to the fetch action, never kept in an atom.
 */

import { atom, useAtomValue, useSetAtom } from "jotai";
import { atomFamily } from "jotai-family";
import { useEffect, useMemo } from "react";

import type { GatewayClient } from "@/lib/api/client";
import type { StepConversionRequest, StepQuoteResponse } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useAppAtomValue } from "@/lib/state/stores";

import { priceEpochAtom } from "./checkoutStore";

export type PriceEntry =
  | { status: "loading" }
  | { status: "done"; cents: number; quote: StepQuoteResponse }
  | { status: "error"; code?: string };

/** One cached price: `${projectId}|${request JSON}`. */
export const priceEntryAtom = atomFamily((key: string) => {
  void key;
  return atom<PriceEntry | null>(null);
});

/** The cache key of one priced request. */
export function priceKey(projectId: string, req: StepConversionRequest, epoch: number): string {
  return `${projectId}|${epoch}|${JSON.stringify(req)}`;
}

type Quoter = Pick<GatewayClient, "quoteStep">;

/** Price one request unless it's priced or on its way; a failed one is
 * asked again next time. */
export const fetchPriceAtom = atom(
  null,
  async (
    get,
    set,
    { client, projectId, req, key }: { client: Quoter; projectId: string; req: StepConversionRequest; key: string },
  ): Promise<void> => {
    const entry = priceEntryAtom(key);
    const now = get(entry);
    if (now !== null && now.status !== "error") return;
    set(entry, { status: "loading" });
    try {
      const q = await client.quoteStep(projectId, req);
      set(entry, { status: "done", cents: q.quote.amount_cents, quote: q });
    } catch (e) {
      set(entry, { status: "error", code: (e as { code?: string }).code });
    }
  },
);

/** Test hook: forget every cached price. */
export function resetPricesForTests(): void {
  for (const k of [...priceEntryAtom.getParams()]) priceEntryAtom.remove(k);
}

/**
 * The prices of several variants of one request, by name, debounced
 * (`delayMs`) after the variants change. A variant missing from the
 * answer is still on its way (or failed).
 */
export function useVariantQuotes(
  projectId: string,
  variants: Record<string, StepConversionRequest>,
  delayMs = 300,
): Record<string, PriceEntry | null> {
  const client = useGateway();
  const epoch = useAppAtomValue(priceEpochAtom);
  const fetchPrice = useSetAtom(fetchPriceAtom);
  const sig = JSON.stringify(variants);
  const keys = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(JSON.parse(sig) as Record<string, StepConversionRequest>).map(([n, r]) => [
          n,
          priceKey(projectId, r, epoch),
        ]),
      ) as Record<string, string>,
    [sig, projectId, epoch],
  );
  const entriesAtom = useMemo(
    () =>
      atom((get) =>
        Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, get(priceEntryAtom(k))])),
      ),
    [keys],
  );
  const entries = useAtomValue(entriesAtom);
  useEffect(() => {
    const reqs = JSON.parse(sig) as Record<string, StepConversionRequest>;
    if (Object.keys(reqs).length === 0) return;
    const t = setTimeout(() => {
      for (const [n, req] of Object.entries(reqs)) {
        void fetchPrice({ client, projectId, req, key: keys[n] });
      }
    }, delayMs);
    return () => clearTimeout(t);
  }, [sig, keys, client, projectId, fetchPrice, delayMs]);
  return entries;
}

/** Just the cents of each variant that has an answer. */
export function centsOf(entries: Record<string, PriceEntry | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [n, e] of Object.entries(entries)) if (e?.status === "done") out[n] = e.cents;
  return out;
}
