/**
 * ADR 0138: the price atoms on their own (a fresh store, a stand-in
 * client): latest wins, the 250 ms debounce, the 10 s timeout and the
 * error, and the side-price cache that sends one quote per request.
 */
import { act, renderHook } from "@testing-library/react";
import { atom, createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StepConversionRequest, StepQuoteResponse } from "@/lib/api/types";

import { EMPTY_CHECKOUT, type StepCheckoutState } from "./checkoutStore";
import { fetchPriceAtom, priceEntryAtom, priceKey } from "./priceAtoms";
import {
  invalidateQuoteAtom,
  QUOTE_DEBOUNCE_MS,
  QUOTE_TIMED_OUT,
  QUOTE_TIMEOUT_MS,
  quoteView,
  requestQuoteAtom,
  useAutoQuote,
} from "./quoteAtoms";

afterEach(() => vi.useRealTimers());

function quote(cents: number): StepQuoteResponse {
  return { step: "production", params: {}, quote: { amount_cents: cents, currency: "usd" }, reuse_stages: null } as never;
}

/** A client whose answers the test hands out, in any order. */
function controlledClient() {
  const calls: { req: StepConversionRequest; resolve: (q: StepQuoteResponse) => void; reject: (e: unknown) => void }[] = [];
  return {
    calls,
    client: {
      quoteStep: (_id: string, req: StepConversionRequest) =>
        new Promise<StepQuoteResponse>((resolve, reject) => calls.push({ req, resolve, reject })),
    },
  };
}

const REQ_A = { step: "production", preset: "4k", formats: ["mvhevc"] } as StepConversionRequest;
const REQ_B = { ...REQ_A, express: true } as StepConversionRequest;
const describeError = (e: unknown) => (e instanceof Error ? e.message : "failed");

function setup() {
  const store = createStore();
  const scope = atom<StepCheckoutState>(EMPTY_CHECKOUT);
  const { calls, client } = controlledClient();
  const ask = (req: StepConversionRequest) =>
    store.set(requestQuoteAtom, { scope, client, projectId: "p1", req, describe: describeError });
  return { store, scope, calls, ask };
}

describe("the run's quote", () => {
  it("latest wins: an older answer landing last is dropped", async () => {
    const { store, scope, calls, ask } = setup();
    const a = ask(REQ_A);
    const b = ask(REQ_B);
    calls[1].resolve(quote(2312));
    await b;
    calls[0].resolve(quote(1632));
    await a;
    const s = store.get(scope);
    expect(s.quote?.quote.amount_cents).toBe(2312);
    expect(quoteView(s, JSON.stringify(REQ_B)).quote?.quote.amount_cents).toBe(2312);
    expect(s.pendingKey).toBeNull();
  });

  it("a change makes the answer on its way stale, and the shown price waits", async () => {
    const { store, scope, calls, ask } = setup();
    const a = ask(REQ_A);
    calls[0].resolve(quote(1632));
    await a;
    const b = ask(REQ_B);
    store.set(invalidateQuoteAtom, scope);
    calls[1].resolve(quote(2312));
    await b;
    const s = store.get(scope);
    expect(s.quote).toBeNull();
    const v = quoteView({ ...s, wantKey: JSON.stringify(REQ_B) });
    expect(v.quote).toBeNull();
    expect(v.updating).toBe(true);
    expect(v.last?.quote.amount_cents).toBe(1632);
  });

  it("never shows a price for other selections", async () => {
    const { store, scope, calls, ask } = setup();
    const a = ask(REQ_A);
    calls[0].resolve(quote(1632));
    await a;
    const v = quoteView(store.get(scope), JSON.stringify(REQ_B));
    expect(v.quote).toBeNull();
    expect(v.updating).toBe(true);
  });

  it("a request with no answer in 10 s fails with Retry's message", async () => {
    vi.useFakeTimers();
    const { store, scope, ask } = setup();
    const a = ask(REQ_A);
    expect(quoteView(store.get(scope), JSON.stringify(REQ_A)).quoting).toBe(true);
    await vi.advanceTimersByTimeAsync(QUOTE_TIMEOUT_MS + 1);
    await a;
    const v = quoteView(store.get(scope), JSON.stringify(REQ_A));
    expect(v.error).toBe(QUOTE_TIMED_OUT);
    expect(v.quoting).toBe(false);
  });

  it("an error shows for its request and clears with the next answer", async () => {
    const { store, scope, calls, ask } = setup();
    const a = ask(REQ_A);
    calls[0].reject(new Error("Something went wrong."));
    await a;
    expect(quoteView(store.get(scope), JSON.stringify(REQ_A)).error).toBe("Something went wrong.");
    const b = ask(REQ_A);
    calls[1].resolve(quote(1632));
    await b;
    const v = quoteView(store.get(scope), JSON.stringify(REQ_A));
    expect(v.error).toBeNull();
    expect(v.quote?.quote.amount_cents).toBe(1632);
  });

  it("debounces: changes settle 250 ms before one quote goes out", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const scope = atom<StepCheckoutState>(EMPTY_CHECKOUT);
    const quoteFn = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
    const { rerender } = renderHook(
      ({ req }: { req: StepConversionRequest }) =>
        useAutoQuote({ scope, key: JSON.stringify(req), stop: false, quote: quoteFn }),
      { wrapper, initialProps: { req: REQ_A } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS - 50);
    });
    rerender({ req: REQ_B });
    rerender({ req: REQ_A });
    rerender({ req: REQ_B });
    expect(quoteFn).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS + 10);
    });
    expect(quoteFn).toHaveBeenCalledTimes(1);
    expect(quoteFn).toHaveBeenCalledWith(REQ_B);
    expect(store.get(scope).wantKey).toBe(JSON.stringify(REQ_B));
  });

  it("a stopped panel asks for nothing", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const scope = atom<StepCheckoutState>(EMPTY_CHECKOUT);
    const quoteFn = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
    renderHook(() => useAutoQuote({ scope, key: JSON.stringify(REQ_A), stop: true, quote: quoteFn }), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(quoteFn).not.toHaveBeenCalled();
  });
});

describe("side prices (quality cards, edge styles, frame rates)", () => {
  it("one quote per request: a repeat while it's on its way or priced sends nothing", async () => {
    const store = createStore();
    const { calls, client } = controlledClient();
    const key = priceKey("p1", REQ_A, 0);
    const go = () => store.set(fetchPriceAtom, { client, projectId: "p1", req: REQ_A, key });
    const first = go();
    void go();
    void go();
    expect(calls).toHaveLength(1);
    calls[0].resolve(quote(850));
    await first;
    await go();
    expect(calls).toHaveLength(1);
    expect(store.get(priceEntryAtom(key))).toMatchObject({ status: "done", cents: 850 });
    priceEntryAtom.remove(key);
  });

  it("a failed price is asked again next time", async () => {
    const store = createStore();
    const { calls, client } = controlledClient();
    const key = priceKey("p1", REQ_B, 0);
    const go = () => store.set(fetchPriceAtom, { client, projectId: "p1", req: REQ_B, key });
    const first = go();
    calls[0].reject(Object.assign(new Error("no"), { code: "plan_required_fps" }));
    await first;
    expect(store.get(priceEntryAtom(key))).toEqual({ status: "error", code: "plan_required_fps" });
    void go();
    expect(calls).toHaveLength(2);
    priceEntryAtom.remove(key);
  });

  it("each request has its own price, so a late one never stands in for another", () => {
    expect(priceKey("p1", REQ_A, 0)).not.toBe(priceKey("p1", REQ_B, 0));
    // a price change (Pro bought) asks again
    expect(priceKey("p1", REQ_A, 0)).not.toBe(priceKey("p1", REQ_A, 1));
  });
});
