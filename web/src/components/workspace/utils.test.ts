import { describe, expect, it } from "vitest";

import { frameToSeconds, parseRational, positionToFrame } from "@/lib/frames";

import {
  clampFrame,
  DEEPEST_ZOOM_VISIBLE_FRAMES,
  DEFAULT_VIEWPORT_PX,
  frameToWindowPosition,
  isExtractionZoom,
  MAX_ZOOM,
  nearestThumb,
  parseCrop,
  planTiles,
  sameCuts,
  scrollFractionToCenter,
  STRIP_HEIGHT_PX,
  TILE_MARGIN,
  tileWidthPx,
  windowPositionToFrame,
  zoomedWindow,
  zoomLevels,
} from "./utils";

describe("parseCrop", () => {
  it("parses the fixture's W:H:X:Y geometry", () => {
    expect(parseCrop("3840:1606:0:276")).toEqual({
      width: 3840,
      height: 1606,
      x: 0,
      y: 276,
    });
  });
  it("rejects garbage and degenerate rects", () => {
    expect(parseCrop(undefined)).toBeNull();
    expect(parseCrop("")).toBeNull();
    expect(parseCrop("3840x1606+0+276")).toBeNull();
    expect(parseCrop("0:100:0:0")).toBeNull();
    expect(parseCrop("100:0:0:0")).toBeNull();
  });
});

describe("nearestThumb", () => {
  const thumbs = [
    { frame: 0, url: "a" },
    { frame: 36, url: "b" },
    { frame: 72, url: "c" },
  ];
  it("returns the largest thumb.frame <= playhead", () => {
    expect(nearestThumb(thumbs, 0)?.url).toBe("a");
    expect(nearestThumb(thumbs, 35)?.url).toBe("a");
    expect(nearestThumb(thumbs, 36)?.url).toBe("b");
    expect(nearestThumb(thumbs, 71)?.url).toBe("b");
    expect(nearestThumb(thumbs, 9999)?.url).toBe("c");
  });
  it("falls back to the first thumb before the first tile, null when empty", () => {
    expect(nearestThumb(thumbs.slice(1), 10)?.url).toBe("b");
    expect(nearestThumb([], 10)).toBeNull();
  });
});

describe("sameCuts / clampFrame", () => {
  it("compares cut lists element-wise", () => {
    expect(sameCuts([1, 2], [1, 2])).toBe(true);
    expect(sameCuts([1, 2], [1, 3])).toBe(false);
    expect(sameCuts([1, 2], [1, 2, 3])).toBe(false);
    expect(sameCuts([], [])).toBe(true);
  });
  it("clamps to [0, numFrames)", () => {
    expect(clampFrame(-5, 100)).toBe(0);
    expect(clampFrame(0, 100)).toBe(0);
    expect(clampFrame(99, 100)).toBe(99);
    expect(clampFrame(100, 100)).toBe(99);
    expect(clampFrame(50, 0)).toBe(0);
  });
});

// Fixture-shaped geometry: 3587 frames @ 24/1 with ~100 strip tiles.
const N = 3587;
const FPS24 = parseRational("24/1");

describe("zoomedWindow", () => {
  it("is the whole strip at fit (zoom 1)", () => {
    expect(zoomedWindow(N, 1, 0)).toEqual({ start: 0, frames: N });
    // zoom is floored at 1 — no zooming OUT past fit
    expect(zoomedWindow(N, 0.5, 0)).toEqual({ start: 0, frames: N });
  });

  it("halves the visible frames per doubling, ceil so the end stays reachable", () => {
    expect(zoomedWindow(N, 2, 0)).toEqual({ start: 0, frames: Math.ceil(N / 2) });
    expect(zoomedWindow(N, 4, 0).frames).toBe(Math.ceil(N / 4));
    expect(zoomedWindow(N, 256, 0).frames).toBe(Math.ceil(N / 256));
  });

  it("a fully scrolled window ends exactly at numFrames", () => {
    for (const zoom of [2, 4, 16, 256]) {
      const win = zoomedWindow(N, zoom, 1 - 1 / zoom);
      expect(win.start + win.frames).toBe(N);
      // clamped even when the scroll fraction overshoots
      const over = zoomedWindow(N, zoom, 0.999999);
      expect(over.start + over.frames).toBe(N);
    }
  });
});

describe("windowed frame doctrine (position ↔ frame round-trip)", () => {
  it("windowPositionToFrame(frameToWindowPosition(f)) === f for EVERY frame at every zoom", () => {
    for (const zoom of [1, 2, 4, 8, 16, 64, 256]) {
      for (const scroll of [0, 0.19, 0.5, 1 - 1 / zoom]) {
        const win = zoomedWindow(N, zoom, scroll);
        for (let f = win.start; f < win.start + win.frames; f++) {
          expect(windowPositionToFrame(frameToWindowPosition(f, win), win)).toBe(f);
        }
      }
    }
  });

  it("maps window-relative positions to ABSOLUTE source frames, clamped half-open", () => {
    const win = zoomedWindow(N, 4, 0.5); // start 1793, frames 897
    expect(win.start).toBeGreaterThan(0);
    expect(windowPositionToFrame(0, win)).toBe(win.start);
    expect(windowPositionToFrame(1, win)).toBe(win.start + win.frames - 1);
    // out-of-window positions clamp to the window edges
    expect(windowPositionToFrame(-0.5, win)).toBe(win.start);
    expect(windowPositionToFrame(1.5, win)).toBe(win.start + win.frames - 1);
    // frames outside the window clamp to 0/1 positions
    expect(frameToWindowPosition(0, win)).toBe(0);
    expect(frameToWindowPosition(N - 1, win)).toBe(1);
  });
});

describe("scrollFractionToCenter", () => {
  it("centers the frame in the zoomed viewport", () => {
    const frame = Math.floor(N / 2);
    const zoom = 4;
    const win = zoomedWindow(N, zoom, scrollFractionToCenter(frame, N, zoom));
    const center = win.start + win.frames / 2;
    expect(Math.abs(center - frame)).toBeLessThanOrEqual(1);
  });

  it("clamps at both ends of the scrollable range", () => {
    expect(scrollFractionToCenter(0, N, 4)).toBe(0);
    expect(scrollFractionToCenter(N - 1, N, 4)).toBeCloseTo(1 - 1 / 4, 12);
    // …so the centered window still contains the frame
    for (const frame of [0, 1, N - 2, N - 1]) {
      const win = zoomedWindow(N, 8, scrollFractionToCenter(frame, N, 8));
      expect(frame).toBeGreaterThanOrEqual(win.start);
      expect(frame).toBeLessThan(win.start + win.frames);
    }
  });
});

describe("zoomLevels", () => {
  it("doubles from fit to exactly 16× for the fixture-length source", () => {
    // the tile plan no longer bounds zoom depth — the deepest level is
    // pinned so 3587 frames / 16 ≈ 224 visible ≤ 240 (a ~10 s window)
    expect(zoomLevels(N)).toEqual([1, 2, 4, 8, 16]);
    expect(zoomLevels(N).at(-1)).toBe(16);
  });

  it("the deepest level shows ≤ DEEPEST_ZOOM_VISIBLE_FRAMES per viewport", () => {
    for (const frames of [N, 24 * 3600, 24 * 86400]) {
      const deepest = zoomLevels(frames).at(-1)!;
      if (deepest < MAX_ZOOM) {
        expect(frames / deepest).toBeLessThanOrEqual(
          DEEPEST_ZOOM_VISIBLE_FRAMES,
        );
        // …and the previous level was NOT deep enough (no wasted levels)
        expect(frames / (deepest / 2)).toBeGreaterThan(
          DEEPEST_ZOOM_VISIBLE_FRAMES,
        );
      }
    }
  });

  it("goes deeper for long sources and caps at MAX_ZOOM", () => {
    const hourFrames = 24 * 3600; // 86400 frames → ≤240 visible needs 512×
    expect(zoomLevels(hourFrames)).toEqual([
      1, 2, 4, 8, 16, 32, 64, 128, 256, 512,
    ]);
    const dayFrames = 24 * 86400; // would need 8640× — hard-capped
    expect(zoomLevels(dayFrames).at(-1)).toBe(MAX_ZOOM);
  });
});

describe("isExtractionZoom (server tiles → extracted frames handoff)", () => {
  const duration = frameToSeconds(N, FPS24); // ≈149.5 s, 100 tiles

  it("fit always stays on server tiles", () => {
    expect(isExtractionZoom(1, 100, N, FPS24)).toBe(false);
  });

  it("switches once a stretched server tile would cover ≤ ~1 s of video", () => {
    // fixture: 100 tiles stretched zoom×; ≤1 s/tile from 2× on
    expect(duration / (100 * 2)).toBeLessThanOrEqual(1);
    expect(isExtractionZoom(2, 100, N, FPS24)).toBe(true);
    expect(isExtractionZoom(16, 100, N, FPS24)).toBe(true);

    // hour-long source: 2× is still 18 s/column — tiles keep resolving
    const hourFrames = 24 * 3600;
    expect(isExtractionZoom(2, 100, hourFrames, FPS24)).toBe(false);
    expect(isExtractionZoom(64, 100, hourFrames, FPS24)).toBe(true);
  });

  it("never extracts without tiles or frames to anchor to", () => {
    expect(isExtractionZoom(16, 0, N, FPS24)).toBe(false);
    expect(isExtractionZoom(16, 100, 0, FPS24)).toBe(false);
  });
});

describe("tileWidthPx", () => {
  it("is strip height × the video aspect (the NLE fixed-width tile)", () => {
    // 90 px strip × 16/9 = 160 px; × 3840/2160 (the fixture probe) = 160 px
    expect(tileWidthPx(16 / 9)).toBe(STRIP_HEIGHT_PX * (16 / 9));
    expect(tileWidthPx(16 / 9)).toBe(160);
    expect(tileWidthPx(3840 / 2160)).toBe(160);
    // 90 × 4/3 = 120; 90 × 2.39 = 215.1 → rounded to 215
    expect(tileWidthPx(4 / 3)).toBe(120);
    expect(tileWidthPx(2.39)).toBe(215);
  });

  it("falls back to 16:9 when the aspect is unknown or degenerate", () => {
    expect(tileWidthPx(undefined)).toBe(160);
    expect(tileWidthPx(0)).toBe(160);
    expect(tileWidthPx(-2)).toBe(160);
  });
});

describe("planTiles", () => {
  // The default geometry: a 960 px viewport of 160 px (16:9) tiles.
  const VIEW = DEFAULT_VIEWPORT_PX; // 960
  const TILE = tileWidthPx(16 / 9); // 160

  it("at fit, exactly viewport/tileW tiles tile the whole strip", () => {
    // stripPx = 960 × 1 = 960 → 960/160 = 6 tiles, no margins possible
    const tiles = planTiles(N, 1, 0, VIEW, TILE);
    expect(tiles).toHaveLength(6);
    expect(tiles.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const t of tiles) {
      // tile i is anchored at pixel i×160 of the 960 px strip
      expect(t.left).toBeCloseTo((t.index * TILE) / VIEW, 12);
      expect(t.width).toBeCloseTo(TILE / VIEW, 12);
      // …and shows the frame at its START boundary (NLE convention)
      expect(t.frame).toBe(positionToFrame(t.left, N));
    }
    // start frames: floor(i/6 × 3587) = 0, 597, 1195, 1793, 2391, 2989
    expect(tiles.map((t) => t.frame)).toEqual([0, 597, 1195, 1793, 2391, 2989]);
  });

  it("keeps the per-screen tile count constant at deep zoom — frames-per-tile shrinks instead", () => {
    const zoom = zoomLevels(N).at(-1)!; // fixture: 16×
    // stripPx = 960 × 16 = 15360 px → 96 tiles total, but only the
    // visible 7 (floor(960/160) + 1 boundary tile) + TILE_MARGIN on the
    // open side are rendered: 7 + 4 = 11 — not hundreds of frame columns
    const tiles = planTiles(N, zoom, 0, VIEW, TILE);
    expect(tiles).toHaveLength(7 + TILE_MARGIN);
    // one tile covers 3587 × 160/15360 ≈ 37.4 frames — successive start
    // frames differ by 37 or 38 (visibleFrames × tileW / viewportPx)
    const framesPerTile = (N * TILE) / (VIEW * zoom); // 3587/96 ≈ 37.4
    expect(framesPerTile).toBeGreaterThan(37);
    expect(framesPerTile).toBeLessThan(38);
    const visible = tiles.slice(0, 7);
    for (let i = 1; i < visible.length; i++) {
      const stride = visible[i].frame - visible[i - 1].frame;
      expect(stride).toBeGreaterThanOrEqual(Math.floor(framesPerTile));
      expect(stride).toBeLessThanOrEqual(Math.ceil(framesPerTile));
    }
  });

  it("plans visible tiles first (left → right), then margins alternating outward", () => {
    // zoom 4 scrolled to 0.5: stripPx = 3840, scrollPx = 1920 →
    // visible tiles 12..18 (floor(1920/160) .. floor(2880/160)),
    // then margins 11,19, 10,20, 9,21, 8,22 (extraction priority order)
    const tiles = planTiles(N, 4, 0.5, VIEW, TILE);
    expect(tiles.map((t) => t.index)).toEqual([
      12, 13, 14, 15, 16, 17, 18, 11, 19, 10, 20, 9, 21, 8, 22,
    ]);
    for (const t of tiles) {
      expect(t.frame).toBe(positionToFrame(t.left, N));
    }
  });

  it("bounds the render volume: one viewport of tiles + both margins", () => {
    for (const zoom of zoomLevels(N)) {
      for (const scroll of [0, 0.33, 1 - 1 / zoom]) {
        const tiles = planTiles(N, zoom, scroll, VIEW, TILE);
        expect(tiles.length).toBeLessThanOrEqual(
          Math.ceil(VIEW / TILE) + 1 + 2 * TILE_MARGIN,
        );
        expect(tiles.length).toBeGreaterThan(0);
      }
    }
  });

  it("clips the last tile to the strip end when tileW does not divide the strip", () => {
    // 1000 px strip of 160 px tiles → 7 tiles; the 7th spans 960..1000 px,
    // so its width clips to 40/1000 = 0.04 of the strip
    const tiles = planTiles(N, 1, 0, 1000, 160);
    expect(tiles).toHaveLength(7);
    const last = tiles.at(-1)!;
    expect(last.index).toBe(6);
    expect(last.left).toBeCloseTo(0.96, 12);
    expect(last.width).toBeCloseTo(0.04, 12);
  });

  it("returns nothing for degenerate inputs", () => {
    expect(planTiles(0, 16, 0, VIEW, TILE)).toEqual([]);
    expect(planTiles(N, 16, 0, 0, TILE)).toEqual([]);
    expect(planTiles(N, 16, 0, VIEW, 0)).toEqual([]);
  });
});
