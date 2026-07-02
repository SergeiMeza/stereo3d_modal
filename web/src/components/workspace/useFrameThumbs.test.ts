/**
 * useFrameThumbs unit tests — the deep-zoom frame extractor's queue, cache
 * and priority logic, driven with a FAKE extractor (jsdom can't decode
 * video; the DOM extractor is guarded to a no-op there, which the last
 * test pins down).
 *
 * Frame doctrine check: extraction seeks use the SAME mid-frame convention
 * as playback (usePreviewPlayer.seekTimeForFrame) so extracted pixels are
 * the exact frame the player would show.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { parseRational } from "@/lib/frames";

import { seekTimeForFrame } from "./usePreviewPlayer";
import {
  createVideoFrameExtractor,
  extractionSeekTime,
  ThumbLRU,
  useFrameThumbs,
  type ExtractorFactory,
  type FrameExtractor,
} from "./useFrameThumbs";
import { DEFAULT_VIEWPORT_PX, planTiles, tileWidthPx } from "./utils";

const FPS24 = parseRational("24/1");
const NTSC = parseRational("24000/1001");
const URL_A = "https://example.test/preview-a.mp4";

/** Deterministic fake: resolves each extract() in arrival order when the
 * test calls flush(); records the exact request order. */
class FakeExtractor implements FrameExtractor {
  calls: number[] = [];
  disposed = false;
  /** frames that extract to a permanent failure (null) */
  failing = new Set<number>();
  private pending: Array<{ frame: number; resolve: (u: string | null) => void }> =
    [];

  extract(frame: number): Promise<string | null> {
    this.calls.push(frame);
    return new Promise((resolve) => this.pending.push({ frame, resolve }));
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Resolve the oldest in-flight extraction (sequential, like the queue). */
  async flush(count = 1): Promise<void> {
    for (let i = 0; i < count; i++) {
      // the pump awaits between extractions — let it enqueue the next one
      await act(async () => {
        const next = this.pending.shift();
        if (!next) return;
        next.resolve(
          this.failing.has(next.frame) ? null : `thumb:${next.frame}`,
        );
        await Promise.resolve();
      });
    }
  }

  get inFlight(): number {
    return this.pending.length;
  }
}

function renderThumbs(extractor: FakeExtractor, wanted: number[], cap = 600) {
  const factory: ExtractorFactory = () => extractor;
  return renderHook(
    ({ frames }: { frames: number[] }) =>
      useFrameThumbs(URL_A, FPS24, frames, factory, cap),
    { initialProps: { frames: wanted } },
  );
}

describe("ThumbLRU", () => {
  it("evicts the least-recently-used entry past the cap", () => {
    const lru = new ThumbLRU(3);
    lru.set(1, "a");
    lru.set(2, "b");
    lru.set(3, "c");
    lru.get(1); // touch — 2 becomes the oldest
    lru.set(4, "d");
    expect(lru.has(2)).toBe(false);
    expect(lru.has(1)).toBe(true);
    expect(lru.has(3)).toBe(true);
    expect(lru.has(4)).toBe(true);
    expect(lru.size).toBe(3);
  });

  it("distinguishes cached failures (null) from never-extracted (undefined)", () => {
    const lru = new ThumbLRU(3);
    lru.set(7, null);
    expect(lru.has(7)).toBe(true); // known — never retried
    expect(lru.get(7)).toBeNull();
    expect(lru.get(8)).toBeUndefined();
  });

  it("rejects a nonsensical cap", () => {
    expect(() => new ThumbLRU(0)).toThrow();
  });
});

describe("extractionSeekTime", () => {
  it("uses the exact mid-frame convention of usePreviewPlayer", () => {
    for (const fps of [FPS24, NTSC]) {
      for (const f of [0, 1, 245, 3586]) {
        expect(extractionSeekTime(f, fps)).toBe(seekTimeForFrame(f, fps));
      }
    }
  });
});

describe("useFrameThumbs", () => {
  it("extracts sequentially in wanted (priority) order and returns the map", async () => {
    const extractor = new FakeExtractor();
    const { result } = renderThumbs(extractor, [10, 11, 12]);

    // strictly sequential: one in flight at a time
    await waitFor(() => expect(extractor.calls).toEqual([10]));
    expect(extractor.inFlight).toBe(1);

    await extractor.flush(3);
    expect(extractor.calls).toEqual([10, 11, 12]);
    expect(result.current.get(10)).toBe("thumb:10");
    expect(result.current.get(11)).toBe("thumb:11");
    expect(result.current.get(12)).toBe("thumb:12");
  });

  it("extracts a deep-zoom tile plan fully, in plan (priority) order", async () => {
    // Fixture geometry at the deepest zoom: 3587 frames, 16×, default
    // 960 px viewport of 160 px (16:9) tiles → 7 visible + 4 margin tiles
    // = 11 extractions per window (not hundreds of per-frame columns).
    const wanted = planTiles(
      3587,
      16,
      0,
      DEFAULT_VIEWPORT_PX,
      tileWidthPx(16 / 9),
    ).map((t) => t.frame);
    expect(wanted).toHaveLength(11);

    const extractor = new FakeExtractor();
    const { result } = renderThumbs(extractor, wanted);
    await extractor.flush(wanted.length);
    expect(extractor.calls).toEqual(wanted); // extraction = plan order
    expect(result.current.size).toBe(wanted.length);
  });

  it("REPLACES the pending queue when the wanted window changes (stale requests dropped)", async () => {
    const extractor = new FakeExtractor();
    const { result, rerender } = renderThumbs(extractor, [10, 11, 12, 13]);
    await waitFor(() => expect(extractor.calls).toEqual([10]));

    // the window scrolled: 11–13 are stale, 20/21 take priority
    rerender({ frames: [20, 21] });
    await extractor.flush(3); // resolves 10, then 20, 21 — never 11–13
    expect(extractor.calls).toEqual([10, 20, 21]);

    expect(result.current.get(20)).toBe("thumb:20");
    expect(result.current.get(21)).toBe("thumb:21");
    // frame 10 stays cached (the map is everything extracted so far)
    expect(result.current.get(10)).toBe("thumb:10");
  });

  it("serves cache hits without re-extracting", async () => {
    const extractor = new FakeExtractor();
    const { result, rerender } = renderThumbs(extractor, [5]);
    await extractor.flush(1);
    expect(extractor.calls).toEqual([5]);

    rerender({ frames: [6] });
    await extractor.flush(1);
    rerender({ frames: [5, 6] }); // both already cached
    expect(extractor.calls).toEqual([5, 6]);
    expect(result.current.get(5)).toBe("thumb:5");
    expect(result.current.get(6)).toBe("thumb:6");
  });

  it("caches failures as permanent misses (degrade to server tiles, no retry)", async () => {
    const extractor = new FakeExtractor();
    extractor.failing.add(8);
    const { result, rerender } = renderThumbs(extractor, [8, 9]);
    await extractor.flush(2);

    expect(result.current.has(8)).toBe(false); // caller falls back to tiles
    expect(result.current.get(9)).toBe("thumb:9");

    rerender({ frames: [8, 9] }); // re-wanting 8 must NOT retry it
    expect(extractor.calls).toEqual([8, 9]);
  });

  it("evicts beyond the cache cap so memory stays bounded", async () => {
    const extractor = new FakeExtractor();
    const { result, rerender } = renderThumbs(extractor, [1, 2, 3], 2);
    await extractor.flush(3);

    // cap 2: frame 1 was evicted, so re-wanting it extracts again
    rerender({ frames: [1] });
    await extractor.flush(1);
    expect(extractor.calls).toEqual([1, 2, 3, 1]);
    expect(result.current.get(1)).toBe("thumb:1");
  });

  it("disposes the extractor on unmount and stops pumping", async () => {
    const extractor = new FakeExtractor();
    const { unmount } = renderThumbs(extractor, [1, 2]);
    await waitFor(() => expect(extractor.calls).toEqual([1]));

    unmount();
    expect(extractor.disposed).toBe(true);
    await extractor.flush(1); // resolving the in-flight seek is a no-op
    expect(extractor.calls).toEqual([1]); // frame 2 never requested
  });

  it("does nothing without a preview url", () => {
    const factory = vi.fn();
    const { result } = renderHook(() =>
      useFrameThumbs(undefined, FPS24, [1, 2], factory as ExtractorFactory),
    );
    expect(factory).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });

  it("the DOM extractor is guarded under jsdom — permanent misses, no decoding", async () => {
    const extractor = createVideoFrameExtractor(URL_A, FPS24);
    await expect(extractor.extract(42)).resolves.toBeNull();
    extractor.dispose();
  });
});
