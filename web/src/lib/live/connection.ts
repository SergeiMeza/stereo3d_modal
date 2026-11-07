/**
 * One live stream (GET /v1/events) and its fallbacks, for one signed-in
 * user (owner 2026-11-07). Plain TypeScript so it can be driven in tests:
 *
 * - connect, apply every event (the snapshot first) into the live atoms;
 * - a broken stream reconnects with exponential backoff and jitter, from
 *   the server's `retry:` up to 30 s, resuming with Last-Event-ID; `bye`
 *   reconnects after its retry_ms;
 * - only while the stream is down, one slow poll (15 s) of the GET routes
 *   fills the same atoms;
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
}

type Timer = ReturnType<typeof setTimeout>;

export class LiveConnection {
  private abort: AbortController | null = null;
  private retryTimer: Timer | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
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
    this.stopPoll();
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
      await readSse(
        body,
        {
          onMessage: (m) => this.onMessage(m),
          onRetry: (ms) => {
            this.baseMs = Math.max(250, ms);
          },
        },
        ac.signal,
      );
    } catch {
      // a refused or broken stream: down below
    }
    if (ac.signal.aborted || !this.running || this.abort !== ac) return;
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
