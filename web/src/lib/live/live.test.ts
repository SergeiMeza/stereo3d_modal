/**
 * The live status feed (owner 2026-11-07): the stream's events, their
 * order rules, the SSE reader, and the connection's reconnect, resume,
 * slow-poll fallback and visibility pause.
 */
import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversion, Project } from "@/lib/api/types";

import { BACKOFF_MAX_MS, FALLBACK_POLL_MS, LiveConnection, STALE_MS, type LiveTransport } from "./connection";
import { parseLiveEvent, versionOf } from "./events";
import { liveConnectionForTests, retainLive, setLiveOptionsForTests } from "./hub";
import {
  activeRunIds,
  applyLiveEvent,
  applyRun,
  liveProjectAtom,
  liveStatusAtom,
  mergeProject,
  mergeRun,
  projectRunIdsAtom,
  resetLive,
  runAtom,
} from "./liveStore";
import { readSse, type SseMessage } from "./sse";

const enc = new TextEncoder();

function run(over: Partial<Conversion> = {}): Conversion {
  return {
    conversion_id: "r1",
    project_id: "p1",
    state: "processing",
    kind: "video",
    params: { preset: "1080p", formats: ["mvhevc"] },
    quote: { amount_cents: 500, currency: "usd" },
    progress: 0.2,
    step: "production",
    created_at: "2026-11-07T00:00:00Z",
    updated_at: "2026-11-07T00:00:01.000001Z",
    ...over,
  } as Conversion;
}

function msg(event: string, id: number, data: Record<string, unknown>): string {
  return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

/** A stream the test writes to. */
function pipe(): { body: ReadableStream<Uint8Array>; push: (s: string) => void; end: () => void; fail: () => void } {
  let c!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      c = controller;
    },
  });
  return {
    body,
    push: (s) => c.enqueue(enc.encode(s)),
    end: () => c.close(),
    fail: () => c.error(new Error("broken")),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("events (the gateway's schema)", () => {
  it("reads run.state, run.progress, project.updated, snapshot and bye", () => {
    const st = parseLiveEvent(
      "run.state",
      JSON.stringify({ type: "run.state", run_id: "r1", project_id: "p1", version: 7, state: "succeeded", run: run({ state: "succeeded" }) }),
      "4",
    );
    expect(st).toMatchObject({ type: "run.state", id: "4", run: { conversion_id: "r1", state: "succeeded", version: 7 } });

    const pr = parseLiveEvent(
      "run.progress",
      JSON.stringify({ run_id: "r1", project_id: "p1", version: 8, state: "processing", progress: 0.62, stage: "render", eta_seconds: 40, waiting_for_gpu: false, queued_s: 0 }),
    );
    expect(pr).toEqual({
      type: "run.progress",
      run: { conversion_id: "r1", project_id: "p1", version: 8, state: "processing", progress: 0.62, stage: "render", eta_seconds: 40, waiting_for_gpu: false, queued_s: 0 },
    });

    const pu = parseLiveEvent("project.updated", JSON.stringify({ project_id: "p1", version: 9, deleted: true, project: { project_id: "p1", name: "Trip" } }));
    expect(pu).toMatchObject({ type: "project.updated", project: { project_id: "p1", name: "Trip", version: 9, deleted: true } });

    const snap = parseLiveEvent("snapshot", JSON.stringify({ version: 1, runs: [run()], projects: [{ project_id: "p1", updated_at: "2026-11-07T00:00:00Z" }] }));
    expect(snap).toMatchObject({ type: "snapshot", runs: [{ conversion_id: "r1", version: versionOf(run().updated_at) }], projects: [{ project_id: "p1" }] });

    expect(parseLiveEvent("bye", JSON.stringify({ reason: "max_age", retry_ms: 1500 }))).toEqual({ type: "bye", retryMs: 1500 });
    expect(parseLiveEvent("run.state", "not json")).toBeNull();
    expect(parseLiveEvent("something.else", "{}")).toBeNull();
  });

  it("reads run.formats, handoff.state, billing.updated and the snapshot's extras (gateway 4578628)", () => {
    expect(parseLiveEvent("run.formats", JSON.stringify({ run_id: "r1", project_id: "p1", version: 5, formats: { pending: ["sbs"] }, outputs: ["mvhevc"] }))).toEqual({
      type: "run.formats",
      formats: { run_id: "r1", version: 5, formats: { pending: ["sbs"] }, outputs: ["mvhevc"] },
    });
    expect(parseLiveEvent("handoff.state", JSON.stringify({ code: "K7M2QX9P", run_id: "r1", version: 6, state: "closed" }))).toEqual({
      type: "handoff.state",
      handoff: { code: "K7M2QX9P", run_id: "r1", version: 6, state: "closed" },
    });
    expect(parseLiveEvent("billing.updated", JSON.stringify({ kind: "settle", settle_id: "s1", version: 7, state: "in_progress", amount_cents: 725 }))).toEqual({
      type: "billing.updated",
      settle: { settle_id: "s1", version: 7, state: "in_progress", amount_cents: 725 },
    });
    expect(parseLiveEvent("billing.updated", JSON.stringify({ kind: "balance", version: 8, balance_cents: 2500, held_cents: 300 }))).toEqual({
      type: "billing.updated",
      balance: { version: 8, balance_cents: 2500, held_cents: 300 },
    });
    const snap = parseLiveEvent(
      "snapshot",
      JSON.stringify({
        version: 9,
        runs: [],
        projects: [],
        run_formats: { r1: { pending: [] } },
        handoffs: [{ code: "C1", run_id: "r1", state: "waiting", version: 3 }],
        settles: [{ settle_id: "s1", state: "open", amount_cents: 100, version: 4 }],
        billing: { balance_cents: 0, held_cents: 0, version: 2 },
      }),
    );
    expect(snap).toMatchObject({
      formats: [{ run_id: "r1", version: 9 }],
      handoffs: [{ code: "C1", state: "waiting" }],
      settles: [{ settle_id: "s1", state: "open" }],
      balance: { version: 2 },
    });
  });

  it("versions are microseconds", () => {
    expect(versionOf("2026-11-07T00:00:01.000001Z") - versionOf("2026-11-07T00:00:01Z")).toBe(1);
  });
});

describe("order: the highest version wins", () => {
  const store = createStore();
  beforeEach(() => resetLive(store));

  it("drops duplicates and older events, per run", () => {
    expect(applyRun(store, { conversion_id: "r1", project_id: "p1", state: "processing", progress: 0.4, version: 10 })).toBe(true);
    // a duplicate (a resume's overlap)
    expect(applyRun(store, { conversion_id: "r1", state: "processing", progress: 0.4, version: 10 })).toBe(false);
    // an older one arriving late
    expect(applyRun(store, { conversion_id: "r1", state: "processing", progress: 0.2, version: 9 })).toBe(false);
    expect(store.get(runAtom("r1"))?.progress).toBe(0.4);
    expect(applyRun(store, { conversion_id: "r1", state: "succeeded", progress: 1, version: 11 })).toBe(true);
    // progress sent before the finish, delivered after it
    expect(applyRun(store, { conversion_id: "r1", state: "processing", progress: 0.9, version: 10.5 })).toBe(false);
    expect(store.get(runAtom("r1"))).toMatchObject({ state: "succeeded", progress: 1 });
    expect(store.get(projectRunIdsAtom("p1"))).toEqual(["r1"]);
  });

  it("drops older project events", () => {
    applyLiveEvent(store, { type: "project.updated", project: { project_id: "p1", name: "New", version: 5 } });
    applyLiveEvent(store, { type: "project.updated", project: { project_id: "p1", name: "Old", version: 4 } });
    expect(store.get(liveProjectAtom("p1"))?.name).toBe("New");
  });

  it("a page's read only wins when it is newer", () => {
    const read = run({ progress: 0.2 });
    expect(mergeRun(read, { conversion_id: "r1", progress: 0.5, version: versionOf(read.updated_at) + 1 }).progress).toBe(0.5);
    expect(mergeRun(read, { conversion_id: "r1", progress: 0.1, version: versionOf(read.updated_at) - 1 }).progress).toBe(0.2);
  });

  it("a snapshot asks again for going runs it doesn't name", () => {
    applyRun(store, run({ conversion_id: "old", state: "processing" }));
    const again = applyLiveEvent(store, { type: "snapshot", runs: [], projects: [] });
    expect(again).toEqual(["old"]);
    expect(activeRunIds(store)).toEqual(["old"]);
  });
});

describe("readSse", () => {
  it("joins chunks, skips comments, and reads id, event, data and retry", async () => {
    const p = pipe();
    const got: SseMessage[] = [];
    let retry = 0;
    const done = readSse(p.body, { onMessage: (m) => got.push(m), onRetry: (ms) => (retry = ms) });
    p.push("retry: 2000\n\n: hb\n\nevent: run.prog");
    p.push('ress\nid: 7\ndata: {"a":\ndata: 1}\n\n');
    p.end();
    await done;
    expect(retry).toBe(2000);
    expect(got).toEqual([{ event: "run.progress", id: "7", data: '{"a":\n1}' }]);
  });
});

describe("a running job's progress (QA 2026-11-07)", () => {
  const project = (progress: number, updated_at: string): Project =>
    ({
      project_id: "p1",
      updated_at,
      analyze: { state: "running", credit_cents: 0, credit_available: false, progress, stage: "thumbnails" },
    }) as unknown as Project;

  it("a newer feed copy never takes a running analysis back: the further % wins", () => {
    const read = project(0.7, "2026-11-07T07:52:53Z");
    const fed = { ...project(0.08, "2026-11-07T07:52:53Z"), version: 9e15 };
    const merged = mergeProject(read, fed, [], () => null);
    expect(merged.analyze.progress).toBe(0.7);
    // and forward when the feed is further along
    const ahead = mergeProject(project(0.2, "2026-11-07T07:52:53Z"), { ...project(0.9, "x"), version: 9e15 }, [], () => null);
    expect(ahead.analyze.progress).toBe(0.9);
  });

  it("a finished analysis from the feed still wins over a running read", () => {
    const read = project(0.7, "2026-11-07T07:52:53Z");
    const done = { ...read, analyze: { state: "succeeded" as const, credit_cents: 0, credit_available: true }, version: 9e15 };
    expect(mergeProject(read, done, [], () => null).analyze.state).toBe("succeeded");
  });
});

describe("LiveConnection", () => {
  const store = createStore();
  let streams: ReturnType<typeof pipe>[];
  let opened: (string | null)[];
  let refuse: boolean;
  let polls: number;
  let transport: LiveTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    resetLive(store);
    streams = [];
    opened = [];
    refuse = false;
    polls = 0;
    transport = {
      open: async (lastId) => {
        opened.push(lastId);
        if (refuse) throw new Error("503");
        const s = pipe();
        streams.push(s);
        return s.body;
      },
      poll: async () => {
        polls += 1;
      },
      resync: async () => {},
    };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects with backoff and resumes after the last event id", async () => {
    const c = new LiveConnection(store, transport, { random: () => 0 });
    c.start();
    await flush();
    expect(store.get(liveStatusAtom)).toBe("open");
    streams[0].push(msg("run.progress", 41, { run_id: "r1", version: 1, state: "processing", progress: 0.3 }));
    streams[0].push(msg("run.progress", 42, { run_id: "r1", version: 2, state: "processing", progress: 0.5 }));
    await flush();
    expect(store.get(runAtom("r1"))?.progress).toBe(0.5);
    streams[0].fail();
    await flush();
    expect(store.get(liveStatusAtom)).toBe("down");
    // jitter 0: half the first step (2 s), then half of 4 s…
    await vi.advanceTimersByTimeAsync(1000);
    expect(opened).toEqual([null, "42"]);
    expect(store.get(liveStatusAtom)).toBe("open");
    c.stop();
  });

  // QA 2026-11-07: a stream that drops mid-analysis, goes quiet or says
  // bye; the poll covers the gap, the reconnect's snapshot brings the page
  // to the current moment, and there's never a second poller
  describe("mid-run drops", () => {
    const snapshotAt = (id: number, progress: number) =>
      msg("snapshot", id, {
        version: id,
        runs: [run({ state: "processing", progress, updated_at: `2026-11-07T00:00:${String(id).padStart(2, "0")}Z` })],
        projects: [],
      });

    it("a broken stream: one read at once, the slow poll, then the snapshot's progress", async () => {
      const c = new LiveConnection(store, transport, { random: () => 0 });
      c.start();
      await flush();
      streams[0].push(snapshotAt(10, 0.08));
      await flush();
      expect(store.get(runAtom("r1"))?.progress).toBe(0.08);
      refuse = true;
      streams[0].fail();
      await flush();
      expect(store.get(liveStatusAtom)).toBe("down");
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
      expect(polls).toBeGreaterThanOrEqual(2);
      refuse = false;
      await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
      expect(store.get(liveStatusAtom)).toBe("open");
      expect(opened.at(-1)).toBe("10");
      streams.at(-1)!.push(snapshotAt(20, 0.7));
      await flush();
      expect(store.get(runAtom("r1"))?.progress).toBe(0.7);
      const after = polls;
      await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 2 - 1000);
      expect(polls).toBe(after);
      c.stop();
    });

    it("a quiet stream (half open, never errors) counts as down after STALE_MS", async () => {
      const c = new LiveConnection(store, transport, { random: () => 0 });
      c.start();
      await flush();
      streams[0].push(snapshotAt(10, 0.08));
      await flush();
      await vi.advanceTimersByTimeAsync(STALE_MS - 1000);
      expect(store.get(liveStatusAtom)).toBe("open");
      expect(polls).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      // down: the read at once, and a reconnect resuming after id 10
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(opened).toEqual([null, "10"]);
      expect(store.get(liveStatusAtom)).toBe("open");
      streams.at(-1)!.push(snapshotAt(20, 0.7));
      await flush();
      expect(store.get(runAtom("r1"))?.progress).toBe(0.7);
      c.stop();
    });

    it("a heartbeat keeps a quiet stream open", async () => {
      const c = new LiveConnection(store, transport, { random: () => 0 });
      c.start();
      await flush();
      for (let i = 0; i < 5; i++) {
        streams[0].push(": hb\n\n");
        await vi.advanceTimersByTimeAsync(20_000);
      }
      expect(store.get(liveStatusAtom)).toBe("open");
      expect(opened).toHaveLength(1);
      expect(polls).toBe(0);
      c.stop();
    });

    it("bye (a server going away): back after retry_ms, with a fresh snapshot", async () => {
      const c = new LiveConnection(store, transport, { random: () => 0 });
      c.start();
      await flush();
      streams[0].push(snapshotAt(10, 0.08));
      streams[0].push(msg("bye", 11, { reason: "listener", retry_ms: 2000 }));
      streams[0].end();
      await flush();
      await vi.advanceTimersByTimeAsync(2000);
      expect(opened).toEqual([null, "11"]);
      streams.at(-1)!.push(snapshotAt(20, 0.7));
      await flush();
      expect(store.get(runAtom("r1"))?.progress).toBe(0.7);
      c.stop();
    });

    it("bye restart (SIGTERM, gateway a729c05): back after its jittered retry_ms, never an error backoff", async () => {
      const c = new LiveConnection(store, transport, { random: () => 0 });
      c.start();
      await flush();
      streams[0].push(snapshotAt(10, 0.3));
      streams[0].push(msg("bye", 11, { reason: "restart", retry_ms: 1700 }));
      streams[0].end();
      await flush();
      // a server going away on purpose: connecting, not down, and no poll
      expect(store.get(liveStatusAtom)).toBe("connecting");
      await vi.advanceTimersByTimeAsync(1699);
      expect(opened).toEqual([null]);
      await vi.advanceTimersByTimeAsync(1);
      expect(opened).toEqual([null, "11"]);
      expect(store.get(liveStatusAtom)).toBe("open");
      expect(polls).toBe(0);
      // the bye wasn't counted: a real break afterwards backs off from the
      // first step (jitter 0: half of 2 s)
      streams.at(-1)!.fail();
      await flush();
      expect(store.get(liveStatusAtom)).toBe("down");
      await vi.advanceTimersByTimeAsync(1000);
      expect(opened).toEqual([null, "11", "11"]);
      c.stop();
    });

    it("several restarts in a row each come back after their own retry_ms", async () => {
      const c = new LiveConnection(store, transport, { random: () => 0 });
      c.start();
      await flush();
      for (const [i, ms] of [[1, 1000], [2, 3000], [3, 2200]] as const) {
        streams.at(-1)!.push(msg("bye", i, { reason: "restart", retry_ms: ms }));
        streams.at(-1)!.end();
        await flush();
        await vi.advanceTimersByTimeAsync(ms);
        expect(opened).toHaveLength(i + 1);
        expect(store.get(liveStatusAtom)).toBe("open");
      }
      expect(polls).toBe(0);
      c.stop();
    });

    it("drops one after another never start a second poller", async () => {
      refuse = true;
      const c = new LiveConnection(store, transport, { random: () => 0 });
      c.start();
      await flush();
      // several failed reconnects while down
      await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS * 3);
      const reconnects = opened.length;
      expect(reconnects).toBeGreaterThan(2);
      const before = polls;
      await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 4);
      // one interval: four ticks in four intervals, whatever the reconnects
      expect(polls - before).toBe(4);
      c.stop();
    });
  });

  it("backs off exponentially with jitter, up to 30 s", () => {
    const c = new LiveConnection(store, transport, { random: () => 1 });
    const steps = Array.from({ length: 6 }, () => c.nextDelay());
    expect(steps).toEqual([2000, 4000, 8000, 16000, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    const low = new LiveConnection(store, transport, { random: () => 0 });
    expect(low.nextDelay()).toBe(1000);
  });

  it("polls slowly only while the stream is down", async () => {
    refuse = true;
    const c = new LiveConnection(store, transport, { random: () => 0 });
    c.start();
    await flush();
    expect(store.get(liveStatusAtom)).toBe("down");
    // one read at once (QA 2026-11-07: what moved meanwhile), then slowly
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    expect(polls).toBe(2);
    // the stream comes back: the poll stops
    refuse = false;
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    expect(store.get(liveStatusAtom)).toBe("open");
    const before = polls;
    // the gateway's heartbeat keeps a quiet stream alive
    for (let i = 0; i < 3; i++) {
      streams.at(-1)!.push(": hb\n\n");
      await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    }
    expect(polls).toBe(before);
    expect(store.get(liveStatusAtom)).toBe("open");
    c.stop();
  });

  it("bye reconnects after its retry_ms, without the slow poll", async () => {
    const c = new LiveConnection(store, transport, { random: () => 0 });
    c.start();
    await flush();
    streams[0].push(msg("bye", 5, { reason: "max_age", retry_ms: 300 }));
    streams[0].end();
    await flush();
    expect(store.get(liveStatusAtom)).toBe("connecting");
    await vi.advanceTimersByTimeAsync(300);
    expect(opened).toEqual([null, "5"]);
    expect(polls).toBe(0);
    c.stop();
  });

  it("pause closes the stream and stops polling; start resyncs", async () => {
    refuse = true;
    const c = new LiveConnection(store, transport, { random: () => 0 });
    c.start();
    await flush();
    // down: its one read at once
    expect(polls).toBe(1);
    c.pause();
    expect(store.get(liveStatusAtom)).toBe("paused");
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 4);
    expect(polls).toBe(1);
    expect(opened).toHaveLength(1);
    refuse = false;
    c.start();
    await flush();
    expect(store.get(liveStatusAtom)).toBe("open");
    streams[0].push(msg("snapshot", 1, { version: 1, runs: [run({ state: "succeeded", progress: 1 })], projects: [] }));
    await flush();
    expect(store.get(runAtom("r1"))?.state).toBe("succeeded");
    c.stop();
  });
});

describe("the hub follows the page's visibility", () => {
  afterEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("pauses while hidden and reconnects when shown", async () => {
    const opens: AbortSignal[] = [];
    setLiveOptionsForTests({ random: () => 0 });
    const client = {
      openEvents: async (_id: string | null, signal: AbortSignal) => {
        opens.push(signal);
        return pipe().body;
      },
      getConversion: vi.fn(),
      getProject: vi.fn(),
      listProjects: vi.fn(),
    };
    const release = retainLive("u1", client as never);
    await flush();
    expect(opens).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(opens[0].aborted).toBe(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(opens).toHaveLength(2);
    expect(liveConnectionForTests()).not.toBeNull();
    release();
  });
});
