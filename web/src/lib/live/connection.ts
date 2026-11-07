/**
 * One live stream (GET /v1/events) and its fallbacks, for one signed-in
 * user (owner 2026-11-07). Plain TypeScript so it can be driven in tests:
 *
 * - connect, apply every event (the snapshot first) into the live atoms;
 * - a broken stream reconnects with exponential backoff and jitter, from
 *   the server's `retry:` up to 30 s, resuming with Last-Event-ID; `bye`
 *   (max_age, listener, and restart on the gateway's SIGTERM with a
 *   jittered 1–3 s) reconnects after its retry_ms, never as an error
 *   backoff and without the poll;
 * - only while the stream is down, one slow poll (15 s) of the GET routes
 *   fills the same atoms, starting with one read at once;
 * - a stream that goes quiet (no event and no heartbeat for STALE_MS; the
 *   gateway comments ": hb" every 20 s) counts as broken: a half-open
 *   connection never errors on its own (QA 2026-11-07);
 * - pause() (page hidden) closes it and stops the poll; start() again
 *   reconnects, and the snapshot resyncs.
 */

import type { createStore } from "jotai";

import { parseLiveEvent } from "./events";
import { applyLiveEvent, liveStatusAtom, type LiveStatus } from "./liveStore";
import { readSse, type SseMessage } from "./sse";

type Store = ReturnType<typeof createStore>;

export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_MAX_MS = 30_000;
export const FALLBACK_POLL_MS = 15_000;
/** Two missed heartbeats and a bit: the stream is stale. */
export const STALE_MS = 45_000;

/** The stream answered something other than 200 (401: a bad token). */
export class LiveStreamError extends Error {
  constructor(public readonly status: number) {
    super(`events stream answered ${status}`);
  }
}

export interface LiveTransport {
  /** GET /v1/events (resuming after lastEventId): the body once it
   * answered 200; throws LiveStreamError otherwise. */
  open(lastEventId: string | null, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  /** The slow poll while the stream is down. */
  poll(): Promise<void>;
  /** Read these runs again (a snapshot didn't name runs we held as going). */
  resync(runIds: string[]): Promise<void>;
}

export interface LiveOptions {
  random?: () => number;
  fallbackMs?: number;
  maxMs?: number;
  staleMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

export class LiveConnection {
  private abort: AbortController | null = null;
  private retryTimer: Timer | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: Timer | null = null;
  private attempt = 0;
  private baseMs = BACKOFF_BASE_MS;
  private lastId: string | null = null;
  private running = false;
  private byeMs: number | null = null;

  constructor(
    private readonly store: Store,
    private readonly transport: LiveTransport,
    private readonly opts: LiveOptions = {},
  ) {}

  /** The last event id applied (resume point). */
  get lastEventId(): string | null {
    return this.lastId;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  /** Page hidden: close the stream and stop polling. */
  pause(): void {
    this.running = false;
    this.teardown();
    this.status("paused");
  }

  /** Signed out: close everything. */
  stop(): void {
    this.running = false;
    this.teardown();
    this.status("idle");
  }

  private status(s: LiveStatus): void {
    if (this.store.get(liveStatusAtom) !== s) this.store.set(liveStatusAtom, s);
  }

  private teardown(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopWatch();
    this.stopPoll();
  }

  /** (Re)arm the quiet-stream watch: no bytes for staleMs aborts it. */
  private watch(ac: AbortController): void {
    this.stopWatch();
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      if (this.abort === ac) ac.abort(new Error("stale"));
    }, this.opts.staleMs ?? STALE_MS);
  }

  private stopWatch(): void {
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = null;
  }

  private stopPoll(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async connect(): Promise<void> {
    this.retryTimer = null;
    const ac = new AbortController();
    this.abort = ac;
    this.byeMs = null;
    if (this.store.get(liveStatusAtom) !== "down") this.status("connecting");
    try {
      const body = await this.transport.open(this.lastId, ac.signal);
      if (ac.signal.aborted) return;
      this.status("open");
      this.attempt = 0;
      this.stopPoll();
      this.watch(ac);
      await readSse(
        body,
        {
          onMessage: (m) => this.onMessage(m),
          onRetry: (ms) => {
            this.baseMs = Math.max(250, ms);
          },
          onActivity: () => this.watch(ac),
        },
        ac.signal,
      );
    } catch {
      // a refused or broken stream: down below
    }
    this.stopWatch();
    // a stale stream was aborted by its own watch: it's down, not closed
    const stale = ac.signal.aborted && ac.signal.reason instanceof Error && ac.signal.reason.message === "stale";
    if ((ac.signal.aborted && !stale) || !this.running || this.abort !== ac) return;
    this.abort = null;
    if (this.byeMs !== null) {
      // the server said goodbye (max age, its listener): come straight back
      this.status("connecting");
      this.retryTimer = setTimeout(() => void this.connect(), this.byeMs);
      return;
    }
    this.status("down");
    this.startPoll();
    this.retryTimer = setTimeout(() => void this.connect(), this.nextDelay());
  }

  /** Exponential backoff with jitter: half the step plus up to half. */
  nextDelay(): number {
    const step = Math.min(this.opts.maxMs ?? BACKOFF_MAX_MS, this.baseMs * 2 ** this.attempt);
    this.attempt += 1;
    const r = (this.opts.random ?? Math.random)();
    return Math.round(step / 2 + (r * step) / 2);
  }

  private startPoll(): void {
    if (this.pollTimer !== null) return;
    // one read at once (what moved while the stream was going down), then
    // the slow poll
    void this.transport.poll().catch(() => {});
    this.pollTimer = setInterval(() => {
      void this.transport.poll().catch(() => {});
    }, this.opts.fallbackMs ?? FALLBACK_POLL_MS);
  }

  private onMessage(m: SseMessage): void {
    // the resume point; duplicates and replays are dropped by version
    // (per run and per project), not by id
    if (m.id !== undefined) this.lastId = m.id;
    const ev = parseLiveEvent(m.event, m.data, m.id);
    if (ev === null) return;
    if (ev.type === "bye") {
      this.byeMs = ev.retryMs ?? this.baseMs;
      return;
    }
    const again = applyLiveEvent(this.store, ev);
    if (again.length > 0) void this.transport.resync(again).catch(() => {});
  }
}
