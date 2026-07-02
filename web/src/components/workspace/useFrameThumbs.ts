"use client";

/**
 * useFrameThumbs — frame-exact thumbnails extracted client-side from the
 * preview proxy (Project.preview_url: frame n of the proxy IS source frame
 * n), for the filmstrip's deep-zoom regime where the ~100 server strip
 * tiles only repeat (workspace utils isExtractionZoom). Callers pass the
 * frames of the visible fixed-width tiles (planTiles) — roughly a dozen
 * per screen, so a window is usually fully extracted within a second.
 *
 * Extraction seeks a HIDDEN, detached <video> using the SAME mid-frame
 * convention as playback (usePreviewPlayer.seekTimeForFrame — boundary
 * times are ambiguous between two frames), awaits 'seeked', and draws the
 * presented frame to a canvas at strip height. One video element, strictly
 * SEQUENTIAL: seeks are fast on the 480p proxy, and a single queue keeps
 * the currently-wanted (visible-first) frames in front — when the wanted
 * list changes the pending queue is simply REPLACED, so stale requests are
 * dropped without any cancellation plumbing.
 *
 * Failures (CORS-tainted canvas readback, decode/seek errors) cache as
 * PERMANENT misses so the strip degrades gracefully to the repeated server
 * tiles instead of retrying forever.
 *
 * jsdom can't decode video: the DOM extractor is guarded (no-op extractor
 * under jsdom / SSR) and the hook takes an injectable factory so tests
 * drive the queue/cache logic with a fake extractor.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { RationalFPS } from "@/lib/frames";

import { seekTimeForFrame } from "./usePreviewPlayer";

/** Extracted thumbs kept per preview proxy — dozens of screenfuls of
 * fixed-width tiles without unbounded data-URL growth. */
export const THUMB_CACHE_CAP = 600;

/** Tiny LRU over frame → thumb URL (Map preserves insertion order; get/set
 * re-insert to refresh recency). `null` values are cached FAILURES —
 * permanent misses that must never be retried. */
export class ThumbLRU {
  private map = new Map<number, string | null>();

  constructor(private readonly cap: number) {
    if (cap <= 0) throw new Error(`LRU cap must be positive, got ${cap}`);
  }

  has(frame: number): boolean {
    return this.map.has(frame);
  }

  /** undefined = never extracted; null = cached failure. Touches recency. */
  get(frame: number): string | null | undefined {
    if (!this.map.has(frame)) return undefined;
    const url = this.map.get(frame) as string | null;
    this.map.delete(frame);
    this.map.set(frame, url);
    return url;
  }

  set(frame: number, url: string | null): void {
    this.map.delete(frame);
    this.map.set(frame, url);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value as number;
      this.map.delete(oldest);
    }
  }

  /** Immutable copy of every SUCCESSFUL extraction (failures excluded) —
   * what the hook hands to React state after each extraction. */
  snapshot(): Map<number, string> {
    const out = new Map<number, string>();
    for (const [frame, url] of this.map) {
      if (url !== null) out.set(frame, url);
    }
    return out;
  }

  get size(): number {
    return this.map.size;
  }
}

export interface FrameExtractor {
  /** Image URL showing exactly `frame`, or null when extraction is
   * impossible (tainted canvas, decode error) — a permanent miss. */
  extract(frame: number): Promise<string | null>;
  dispose(): void;
}

export type ExtractorFactory = (
  previewUrl: string,
  fps: RationalFPS,
) => FrameExtractor;

/** Mid-frame seek time for extraction — the SAME convention as playback
 * (usePreviewPlayer), so extracted pixels match what the player shows. */
export function extractionSeekTime(frame: number, fps: RationalFPS): number {
  return seekTimeForFrame(frame, fps);
}

/** Extracted thumbs render at the filmstrip's strip height. */
const EXTRACT_HEIGHT = 90;

/** Degraded extractor: every frame is a permanent miss (server tiles show
 * instead). Used under jsdom/SSR where <video> never decodes. */
const noopExtractor: FrameExtractor = {
  extract: () => Promise.resolve(null),
  dispose: () => {},
};

/** jsdom renders <video> but never decodes or fires 'seeked'; the guard
 * keeps unit tests (and SSR) from instantiating real decoding. */
function canDecodeVideo(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof navigator !== "undefined" &&
    !/jsdom/i.test(navigator.userAgent)
  );
}

/** DOM extractor: hidden detached <video> + canvas, sequential use only
 * (the hook's queue guarantees one extract() in flight at a time). */
export function createVideoFrameExtractor(
  previewUrl: string,
  fps: RationalFPS,
): FrameExtractor {
  if (!canDecodeVideo()) return noopExtractor;

  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  // GCS signed URLs serve CORS headers; without this attribute every
  // canvas readback would taint.
  video.crossOrigin = "anonymous";
  video.src = previewUrl;
  const canvas = document.createElement("canvas");
  let broken = false; // decode error or tainted canvas — degrade to tiles
  let disposed = false;

  function waitFor(type: "loadedmetadata" | "seeked"): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        video.removeEventListener(type, onOk);
        video.removeEventListener("error", onErr);
        resolve(ok);
      };
      const onOk = () => done(true);
      const onErr = () => done(false);
      video.addEventListener(type, onOk);
      video.addEventListener("error", onErr);
    });
  }

  return {
    async extract(frame: number): Promise<string | null> {
      if (broken || disposed) return null;
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
        if (!(await waitFor("loadedmetadata"))) {
          broken = true;
          return null;
        }
      }
      video.currentTime = extractionSeekTime(frame, fps);
      if (!(await waitFor("seeked"))) {
        broken = true;
        return null;
      }
      if (disposed) return null;
      const w = Math.max(
        1,
        Math.round(
          (EXTRACT_HEIGHT * video.videoWidth) / Math.max(video.videoHeight, 1),
        ),
      );
      canvas.width = w;
      canvas.height = EXTRACT_HEIGHT;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        broken = true;
        return null;
      }
      try {
        ctx.drawImage(video, 0, 0, w, EXTRACT_HEIGHT);
        return canvas.toDataURL("image/jpeg", 0.7);
      } catch {
        // tainted readback (proxy served without CORS) — permanent
        broken = true;
        return null;
      }
    },
    dispose() {
      disposed = true;
      video.removeAttribute("src");
      video.load();
    },
  };
}

interface ThumbState {
  url: string;
  extractor: FrameExtractor;
  cache: ThumbLRU;
  /** pending frames, priority order; REPLACED whenever `wanted` changes */
  queue: number[];
  pumping: boolean;
  disposed: boolean;
}

const EMPTY_THUMBS: ReadonlyMap<number, string> = new Map();

/**
 * Thumbnails for `wanted` frames (priority order — put the visible window
 * first). Returns everything extracted so far for the current previewUrl
 * (LRU-bounded); callers fall back to the nearest server tile for the
 * rest. Cache and extractor survive zoom/scroll churn; the mutable
 * machinery lives in a ref touched only from effects/the async pump (never
 * during render), and progress reaches React as immutable snapshots.
 */
export function useFrameThumbs(
  previewUrl: string | undefined,
  fps: RationalFPS,
  wanted: readonly number[],
  createExtractor: ExtractorFactory = createVideoFrameExtractor,
  cacheCap: number = THUMB_CACHE_CAP,
): ReadonlyMap<number, string> {
  // Snapshot of the cache's successes, tagged with the proxy it came from
  // so a URL swap can never show another video's pixels.
  const [snap, setSnap] = useState<{
    url: string;
    thumbs: ReadonlyMap<number, string>;
  } | null>(null);
  const stateRef = useRef<ThumbState | null>(null);

  useEffect(() => {
    if (!previewUrl) return;
    let st = stateRef.current;
    if (!st || st.url !== previewUrl) {
      if (st) {
        st.disposed = true;
        st.extractor.dispose();
      }
      st = {
        url: previewUrl,
        extractor: createExtractor(previewUrl, fps),
        cache: new ThumbLRU(cacheCap),
        queue: [],
        pumping: false,
        disposed: false,
      };
      stateRef.current = st;
    }
    const state = st;
    // Reprioritize: replace the pending queue with the new wanted order;
    // frames already resolved (hits or permanent misses) are skipped.
    state.queue = wanted.filter((f) => !state.cache.has(f));

    async function pump(): Promise<void> {
      if (state.pumping) return; // the running pump reads state.queue live
      state.pumping = true;
      try {
        for (;;) {
          if (state.disposed) return;
          const frame = state.queue.shift();
          if (frame === undefined) return;
          if (state.cache.has(frame)) continue;
          let url: string | null = null;
          try {
            url = await state.extractor.extract(frame);
          } catch {
            url = null;
          }
          if (state.disposed) return;
          state.cache.set(frame, url);
          if (url !== null) {
            setSnap({ url: state.url, thumbs: state.cache.snapshot() });
          }
        }
      } finally {
        state.pumping = false;
      }
    }
    void pump();
  }, [previewUrl, fps, wanted, createExtractor, cacheCap]);

  // Dispose on unmount only — zooming back out (previewUrl → undefined)
  // keeps the cache warm for the next zoom-in.
  useEffect(
    () => () => {
      const st = stateRef.current;
      if (st) {
        st.disposed = true;
        st.extractor.dispose();
        stateRef.current = null;
      }
    },
    [],
  );

  return useMemo(
    () => (snap && snap.url === previewUrl ? snap.thumbs : EMPTY_THUMBS),
    [snap, previewUrl],
  );
}
