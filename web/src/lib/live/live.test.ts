/**
 * The live status feed (owner 2026-11-07): the stream's events, their
 * order rules, the SSE reader, and the connection's reconnect, resume,
 * slow-poll fallback and visibility pause.
 */
import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversion } from "@/lib/api/types";

import { BACKOFF_MAX_MS, FALLBACK_POLL_MS, LiveConnection, type LiveTransport } from "./connection";
import { parseLiveEvent, versionOf } from "./events";
import { liveConnectionForTests, retainLive, setLiveOptionsForTests } from "./hub";
import {
  activeRunIds,
  applyLiveEvent,
  applyRun,
  liveProjectAtom,
  liveStatusAtom,
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
    expect(polls).toBe(0);
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    expect(polls).toBe(1);
    // the stream comes back: the poll stops
    refuse = false;
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    expect(store.get(liveStatusAtom)).toBe("open");
    const before = polls;
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 3);
    expect(polls).toBe(before);
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
    c.pause();
    expect(store.get(liveStatusAtom)).toBe("paused");
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 4);
    expect(polls).toBe(0);
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
