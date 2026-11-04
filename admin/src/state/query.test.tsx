import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type AdminApi } from "@/lib/api";
import type { AdminAuth } from "@/lib/auth";
import { sessionOptionsQuery } from "@/lib/services";
import { createQuery, QUERY_TIMEOUT_MS, QueryTimeout, useQuery } from "./query";
import { servicesAtom } from "./services";

/** The async query atom itself (ADR 0138). */

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function wrapperFor(store: ReturnType<typeof createStore>) {
  return ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("query atoms", () => {
  it("latest wins: a slow old answer doesn't overwrite a newer one", async () => {
    const calls: ReturnType<typeof deferred<string>>[] = [];
    const q = createQuery((_get, _p: string) => {
      const d = deferred<string>();
      calls.push(d);
      return d.promise;
    });
    const store = createStore();

    const old = store.set(q.run, "a");
    const newer = store.set(q.run, "a", "keep");
    calls[1].resolve("new");
    await newer;
    calls[0].resolve("old");
    await old;

    expect(store.get(q.value("a"))).toEqual({ kind: "loaded", data: "new" });
  });

  it("latest wins: a slow old failure doesn't replace a newer answer either", async () => {
    const calls: ReturnType<typeof deferred<string>>[] = [];
    const q = createQuery((_get, _p: null) => {
      const d = deferred<string>();
      calls.push(d);
      return d.promise;
    });
    const store = createStore();

    const old = store.set(q.run, null).catch(() => undefined);
    const newer = store.set(q.run, null);
    calls[1].resolve("new");
    await newer;
    calls[0].reject(new ApiError(500, "internal", "boom"));
    await old;

    expect(store.get(q.value(null))).toEqual({ kind: "loaded", data: "new" });
  });

  it("an answer put by an action beats a load still in flight", async () => {
    const d = deferred<string>();
    const q = createQuery((_get, _p: null) => d.promise);
    const store = createStore();

    const load = store.set(q.run, null);
    store.set(q.put, null, "from the action");
    d.resolve("stale");
    await load;

    expect(store.get(q.value(null))).toEqual({ kind: "loaded", data: "from the action" });
  });

  it("times out after 20 s into the error state, and Retry recovers", async () => {
    vi.useFakeTimers();
    let answer: Promise<string> = new Promise(() => {}); // the gateway never answers
    const fetcher = vi.fn((_get, _p: string) => answer);
    const q = createQuery(fetcher);
    const store = createStore();

    const { result } = renderHook(() => useQuery(q, "x"), { wrapper: wrapperFor(store) });
    expect(result.current.state.kind).toBe("loading");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUERY_TIMEOUT_MS - 1);
    });
    expect(result.current.state.kind).toBe("loading");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const failed = result.current.state;
    expect(failed.kind).toBe("error");
    expect(failed.kind === "error" && failed.error).toBeInstanceOf(QueryTimeout);
    expect(failed.kind === "error" && (failed.error as ApiError).status).toBe(504);

    answer = Promise.resolve("back");
    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toEqual({ kind: "loaded", data: "back" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a gateway error leads to the error state, and Retry recovers", async () => {
    let fail = true;
    const q = createQuery(async (_get, _p: null) => {
      if (fail) throw new ApiError(503, "unavailable", "The gateway is down.");
      return ["case"];
    });
    const store = createStore();

    const { result } = renderHook(() => useQuery(q, null), { wrapper: wrapperFor(store) });
    await waitFor(() => expect(result.current.state.kind).toBe("error"));
    const s = result.current.state;
    expect(s.kind === "error" && (s.error as ApiError).code).toBe("unavailable");

    fail = false;
    act(() => result.current.retry());
    expect(result.current.state.kind).toBe("loading");
    await waitFor(() => expect(result.current.state).toEqual({ kind: "loaded", data: ["case"] }));
  });

  it("a failed reload keeps what was on screen as the error's data", async () => {
    let fail = false;
    const q = createQuery(async (_get, _p: null) => {
      if (fail) throw new ApiError(500, "internal", "boom");
      return 1;
    });
    const store = createStore();

    await store.set(q.run, null);
    fail = true;
    await store.set(q.run, null, "keep").catch(() => undefined);

    const s = store.get(q.value(null));
    expect(s?.kind).toBe("error");
    expect(s?.kind === "error" && s.data).toBe(1);
  });

  it("a new session's Provider starts empty: nothing from the previous one", async () => {
    let who = "first@example.com";
    const fetcher = vi.fn(async (_get, _p: null) => `data of ${who}`);
    const q = createQuery(fetcher);
    function Show() {
      const { state } = useQuery(q, null);
      return <p>{state.kind === "loaded" ? state.data : state.kind}</p>;
    }
    // as App does: one Provider per signed-in session, keyed by the email
    const Session = ({ email }: { email: string }) => (
      <Provider key={`in:${email}`}>
        <Show />
      </Provider>
    );

    const { rerender } = render(<Session email="first@example.com" />);
    expect(await screen.findByText("data of first@example.com")).toBeInTheDocument();

    let release!: () => void;
    who = "second@example.com";
    fetcher.mockImplementationOnce(
      (_get, _p: null) => new Promise<string>((res) => (release = () => res(`data of ${who}`))),
    );
    rerender(<Session email="second@example.com" />);

    // the first session's answer isn't shown while the second one loads
    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(screen.queryByText("data of first@example.com")).not.toBeInTheDocument();
    await act(async () => release());
    expect(await screen.findByText("data of second@example.com")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("coming back to a screen shows its last answer while it refreshes", async () => {
    let n = 0;
    const q = createQuery(async (_get, _p: null) => ++n);
    const store = createStore();

    const first = renderHook(() => useQuery(q, null), { wrapper: wrapperFor(store) });
    await waitFor(() => expect(first.result.current.state).toEqual({ kind: "loaded", data: 1 }));
    first.unmount();

    const again = renderHook(() => useQuery(q, null), { wrapper: wrapperFor(store) });
    expect(again.result.current.state).toEqual({ kind: "loaded", data: 1 });
    await waitFor(() => expect(again.result.current.state).toEqual({ kind: "loaded", data: 2 }));
  });
});

describe("the passkey challenge query", () => {
  it("never serves a cached challenge: each opening loads a new one", async () => {
    let n = 0;
    const pending: ((v: unknown) => void)[] = [];
    const sessionOptions = vi.fn(
      () =>
        new Promise((res) => {
          const challenge = `challenge-${++n}`;
          pending.push(() => res({ challenge, rpId: "admin.test" }));
        }),
    );
    const store = createStore();
    store.set(servicesAtom, {
      api: { sessionOptions } as unknown as AdminApi,
      auth: {} as AdminAuth,
      email: "owner@example.com",
    });

    const first = renderHook(() => useQuery(sessionOptionsQuery, "sign_in"), { wrapper: wrapperFor(store) });
    await act(async () => pending[0]({}));
    await waitFor(() => expect(first.result.current.state.kind).toBe("loaded"));
    const s1 = first.result.current.state;
    expect(s1.kind === "loaded" && s1.data.challenge).toBe("challenge-1");
    first.unmount();

    // reopened: the used challenge isn't on screen, even for a moment
    const again = renderHook(() => useQuery(sessionOptionsQuery, "sign_in"), { wrapper: wrapperFor(store) });
    expect(again.result.current.state.kind).toBe("loading");
    expect(sessionOptions).toHaveBeenCalledTimes(2);
    await act(async () => pending[1]({}));
    await waitFor(() => expect(again.result.current.state.kind).toBe("loaded"));
    const s2 = again.result.current.state;
    expect(s2.kind === "loaded" && s2.data.challenge).toBe("challenge-2");
  });

  it("isn't shared between purposes", async () => {
    const sessionOptions = vi.fn(async (purpose: string) => ({ challenge: purpose }));
    const store = createStore();
    store.set(servicesAtom, {
      api: { sessionOptions } as unknown as AdminApi,
      auth: {} as AdminAuth,
      email: "owner@example.com",
    });

    await store.set(sessionOptionsQuery.run, "sign_in");
    expect(store.get(sessionOptionsQuery.value("reassert"))).toBeNull();
    await store.set(sessionOptionsQuery.run, "reassert");
    const r = store.get(sessionOptionsQuery.value("reassert"));
    expect(r?.kind === "loaded" && r.data.challenge).toBe("reassert");
  });
});
