/**
 * BL-34: the gateway route (Heiki ADR-0129's rules). A connection failure
 * moves the route and an HTTP status never does; the relay is remembered
 * per browser; the direct host is asked again every 6 h; pins and China
 * mode by country are never probed; with the route off nothing changes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DIRECT_RECHECK_MS,
  GatewayRoute,
  PROBE_TIMEOUT_MS,
  REPROBE_MIN_GAP_MS,
  ROUTE_STORAGE_KEY,
  isConnectionFailure,
} from "@/lib/gatewayRoute";
import type { RouteDeps, RouteName } from "@/lib/gatewayRoute";

const DIRECT = "https://api.example.test";
const RELAY = "https://cn.api.example.test";

/** What a host does: answer with a status, fail to connect, or say nothing. */
type Answer = number | "fail" | "hang";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

function harness(opts: {
  direct?: Answer;
  relay?: Answer;
  home?: "cn" | "global";
  pinned?: boolean;
  enabled?: boolean;
  storage?: Storage | null;
  online?: boolean;
  now?: number;
}) {
  const answers: Record<RouteName, Answer> = { direct: opts.direct ?? 200, cn_relay: opts.relay ?? 200 };
  const state = { now: opts.now ?? 1_700_000_000_000, online: opts.online ?? true };
  const calls: { route: RouteName; mode: RequestMode | undefined }[] = [];
  const storage = opts.storage === undefined ? memoryStorage() : opts.storage;
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const route: RouteName = url.startsWith(RELAY) ? "cn_relay" : "direct";
    expect(url).toBe(`${route === "cn_relay" ? RELAY : DIRECT}/health`);
    calls.push({ route, mode: init?.mode });
    const a = answers[route];
    if (a === "fail") throw new TypeError("Failed to fetch");
    if (a === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return new Response(null, { status: a });
  });
  const deps: RouteDeps = {
    enabled: () => opts.enabled ?? true,
    home: () => opts.home ?? "global",
    pinned: () => opts.pinned ?? false,
    hosts: () => ({ direct: DIRECT, cnRelay: RELAY }),
    fetch: fetchFn as unknown as typeof fetch,
    storage: () => storage,
    now: () => state.now,
    online: () => state.online,
  };
  const route = new GatewayRoute(deps);
  const changed = vi.fn();
  route.subscribe(changed);
  return { route, deps, answers, state, calls, storage, fetchFn, changed, again: () => new GatewayRoute(deps) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isConnectionFailure", () => {
  it("is a TypeError or a timeout, never an abort or an answer", () => {
    expect(isConnectionFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isConnectionFailure(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isConnectionFailure(new DOMException("a", "AbortError"))).toBe(false);
    expect(isConnectionFailure(Object.assign(new Error("server_error"), { status: 503 }))).toBe(false);
    expect(isConnectionFailure(null)).toBe(false);
  });
});

describe("no switch on an HTTP status", () => {
  for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
    it(`stays direct when /health answers ${status}`, async () => {
      const h = harness({ direct: status });
      await h.route.prepare();
      expect(h.route.current()).toBe("direct");
      expect(h.calls.map((c) => c.route)).toEqual(["direct"]);
      expect(h.storage?.getItem(ROUTE_STORAGE_KEY)).toBeNull();
      expect(h.changed).not.toHaveBeenCalled();
    });
  }

  it("probes without CORS, so any answer counts", async () => {
    const h = harness({});
    await h.route.prepare();
    expect(h.calls[0].mode).toBe("no-cors");
  });
});

describe("a switch on a connection failure", () => {
  it("moves to the relay when the direct host can't be reached", async () => {
    const h = harness({ direct: "fail" });
    await h.route.prepare();
    expect(h.route.current()).toBe("cn_relay");
    expect(h.route.baseUrl()).toBe(RELAY);
    expect(h.calls.map((c) => c.route)).toEqual(["direct", "cn_relay"]);
    expect(h.changed).toHaveBeenCalledTimes(1);
  });

  it("moves after 5 s of silence (a blocked host says nothing)", async () => {
    vi.useFakeTimers();
    const h = harness({ direct: "hang" });
    const done = h.route.prepare();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(h.route.current()).toBe("direct");
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.route.current()).toBe("cn_relay");
  });

  it("an HTTP status from the relay is an answer too", async () => {
    const h = harness({ direct: "fail", relay: 502 });
    await h.route.prepare();
    expect(h.route.current()).toBe("cn_relay");
  });

  it("stays where it was when neither host answers", async () => {
    const h = harness({ direct: "fail", relay: "fail" });
    await h.route.prepare();
    expect(h.route.current()).toBe("direct");
    expect(h.route.settled).toBe(true);
    expect(h.storage?.getItem(ROUTE_STORAGE_KEY)).toBeNull();
  });

  it("doesn't move while the browser is offline, and asks again later", async () => {
    const h = harness({ direct: "fail", online: false });
    await h.route.prepare();
    expect(h.route.current()).toBe("direct");
    expect(h.calls).toEqual([]);
    expect(h.route.settled).toBe(false);
    h.state.online = true;
    await h.route.prepare();
    expect(h.route.current()).toBe("cn_relay");
  });

  it("probes once per page load, shared by concurrent callers", async () => {
    const h = harness({ direct: "fail" });
    await Promise.all([h.route.prepare(), h.route.prepare(), h.route.prepare()]);
    await h.route.prepare();
    expect(h.calls.map((c) => c.route)).toEqual(["direct", "cn_relay"]);
  });
});

describe("remembering the route", () => {
  it("keeps the relay for the next page load, which asks it first", async () => {
    const h = harness({ direct: "fail" });
    await h.route.prepare();
    const saved = JSON.parse(h.storage?.getItem(ROUTE_STORAGE_KEY) ?? "null") as { route: string; directCheckedAt: number };
    expect(saved).toEqual({ route: "cn_relay", directCheckedAt: h.state.now });

    h.calls.length = 0;
    const next = h.again();
    expect(next.current()).toBe("cn_relay"); // before any probe
    await next.prepare();
    expect(h.calls.map((c) => c.route)).toEqual(["cn_relay"]);
    expect(next.current()).toBe("cn_relay");
  });

  it("forgets the relay when, on a later load, only direct answers", async () => {
    const h = harness({ direct: "fail" });
    await h.route.prepare();
    h.answers.direct = 200;
    h.answers.cn_relay = "fail";
    const next = h.again();
    await next.prepare();
    expect(next.current()).toBe("direct");
    expect(h.storage?.getItem(ROUTE_STORAGE_KEY)).toBeNull();
  });

  it("works for the page when storage is blocked", async () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    const h = harness({ direct: "fail", storage: blocked });
    await h.route.prepare();
    expect(h.route.current()).toBe("cn_relay");
    expect(h.again().current()).toBe("direct");
  });

  it("ignores junk in storage", () => {
    const storage = memoryStorage();
    storage.setItem(ROUTE_STORAGE_KEY, "{not json");
    expect(harness({ storage }).route.current()).toBe("direct");
    storage.setItem(ROUTE_STORAGE_KEY, JSON.stringify({ route: "mars" }));
    expect(harness({ storage }).route.current()).toBe("direct");
  });
});

describe("the 6 h recheck of the direct host", () => {
  async function onRelay() {
    const h = harness({ direct: "fail" });
    await h.route.prepare();
    h.calls.length = 0;
    return h;
  }

  it("isn't due before 6 h", async () => {
    const h = await onRelay();
    h.state.now += DIRECT_RECHECK_MS - 1;
    expect(h.route.isDirectRecheckDue()).toBe(false);
    expect(await h.route.recheckDirect()).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("after 6 h, a 200 sends the next page load back to direct; this page stays", async () => {
    const h = await onRelay();
    h.state.now += DIRECT_RECHECK_MS;
    h.answers.direct = 200;
    expect(h.route.isDirectRecheckDue()).toBe(true);
    expect(await h.route.recheckDirect()).toBe(true);
    expect(h.calls).toEqual([{ route: "direct", mode: undefined }]); // with CORS: the status counts
    expect(h.route.current()).toBe("cn_relay");
    expect(h.storage?.getItem(ROUTE_STORAGE_KEY)).toBeNull();
    expect(h.again().current()).toBe("direct");
  });

  for (const answer of [503, 404, "fail"] as const) {
    it(`keeps the relay when direct answers ${answer}, and waits another 6 h`, async () => {
      const h = await onRelay();
      h.state.now += DIRECT_RECHECK_MS;
      h.answers.direct = answer;
      expect(await h.route.recheckDirect()).toBe(false);
      expect(h.again().current()).toBe("cn_relay");
      expect(h.route.isDirectRecheckDue()).toBe(false);
      h.state.now += DIRECT_RECHECK_MS;
      expect(h.route.isDirectRecheckDue()).toBe(true);
    });
  }

  it("is never due on direct", async () => {
    const h = harness({});
    await h.route.prepare();
    h.state.now += 10 * DIRECT_RECHECK_MS;
    expect(h.route.isDirectRecheckDue()).toBe(false);
  });
});

describe("pins and China mode by country", () => {
  it("a pin to direct (?region=global) is never probed and never moves", async () => {
    const storage = memoryStorage();
    storage.setItem(ROUTE_STORAGE_KEY, JSON.stringify({ route: "cn_relay", directCheckedAt: 0 }));
    const h = harness({ direct: "fail", pinned: true, storage });
    await h.route.prepare();
    expect(h.route.current()).toBe("direct");
    expect(h.calls).toEqual([]);
    h.route.reportFailure(new TypeError("Failed to fetch"));
    await h.route.prepare();
    expect(h.calls).toEqual([]);
    expect(await h.route.recheckDirect()).toBe(false);
  });

  it("a pin to the relay (?region=cn) is never probed", async () => {
    const h = harness({ relay: "fail", home: "cn", pinned: true });
    await h.route.prepare();
    expect(h.route.current()).toBe("cn_relay");
    expect(h.calls).toEqual([]);
  });

  it("China mode by country stays on the relay, as before", async () => {
    const h = harness({ relay: "fail", home: "cn" });
    await h.route.prepare();
    expect(h.route.current()).toBe("cn_relay");
    expect(h.calls).toEqual([]);
  });
});

describe("a failed request", () => {
  it("asks again on a connection failure, at most once a minute", async () => {
    const h = harness({});
    await h.route.prepare();
    h.answers.direct = "fail";
    h.route.reportFailure(new TypeError("Failed to fetch"));
    await h.route.prepare();
    expect(h.route.current()).toBe("cn_relay");

    h.answers.cn_relay = "fail";
    h.answers.direct = 200;
    h.calls.length = 0;
    h.route.reportFailure(new TypeError("Failed to fetch"));
    await h.route.prepare();
    expect(h.calls).toEqual([]);
    h.state.now += REPROBE_MIN_GAP_MS;
    h.route.reportFailure(new TypeError("Failed to fetch"));
    await h.route.prepare();
    expect(h.route.current()).toBe("direct");
  });

  it("a blip stays: the current host is asked first", async () => {
    const h = harness({});
    await h.route.prepare();
    h.calls.length = 0;
    h.route.reportFailure(new TypeError("Failed to fetch"));
    await h.route.prepare();
    expect(h.calls.map((c) => c.route)).toEqual(["direct"]);
    expect(h.route.current()).toBe("direct");
  });

  it("ignores anything but a connection failure, and an offline browser", async () => {
    const h = harness({});
    await h.route.prepare();
    h.calls.length = 0;
    h.route.reportFailure(Object.assign(new Error("server_error"), { status: 500 }));
    h.route.reportFailure(new DOMException("aborted", "AbortError"));
    h.state.online = false;
    h.route.reportFailure(new TypeError("Failed to fetch"));
    await h.route.prepare();
    expect(h.calls).toEqual([]);
  });
});

describe("off (tests, the mock gateway, NEXT_PUBLIC_GATEWAY_FALLBACK=0)", () => {
  it("is the region's route and never probes, whatever is remembered", async () => {
    const storage = memoryStorage();
    storage.setItem(ROUTE_STORAGE_KEY, JSON.stringify({ route: "cn_relay", directCheckedAt: 0 }));
    const h = harness({ direct: "fail", enabled: false, storage });
    await h.route.prepare();
    expect(h.route.current()).toBe("direct");
    expect(h.calls).toEqual([]);
    expect(harness({ enabled: false, home: "cn" }).route.current()).toBe("cn_relay");
  });
});
