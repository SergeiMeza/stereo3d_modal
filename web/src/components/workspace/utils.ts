/**
 * Workspace-only helpers.
 *
 * Frame doctrine: frames are opaque integers here; every frame/time/position
 * conversion COMPOSES the helpers in src/lib/frames.ts (positionToFrame,
 * frameToPosition, frameToSeconds) — no fps arithmetic is done directly.
 * The windowed variants below apply positionToFrame/frameToPosition over a
 * ZOOMED slice of the filmstrip so hit-testing stays frame-exact at any zoom.
 */

import type { Thumb } from "@/lib/api/types";
import {
  frameToPosition,
  frameToSeconds,
  positionToFrame,
  type RationalFPS,
} from "@/lib/frames";

/** Active-picture geometry parsed from the probe's "W:H:X:Y" crop string
 * (coordinates in SOURCE pixels). */
export interface CropRect {
  width: number;
  height: number;
  x: number;
  y: number;
}

export function parseCrop(crop: string | undefined): CropRect | null {
  if (!crop) return null;
  const m = /^(\d+):(\d+):(\d+):(\d+)$/.exec(crop.trim());
  if (!m) return null;
  const rect: CropRect = {
    width: Number(m[1]),
    height: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4]),
  };
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

/** The thumbnail that covers `frame`: the entry with the largest
 * thumb.frame <= frame (thumbs need not be sorted). Falls back to the
 * first thumb so a playhead before the first tile still shows something. */
export function nearestThumb(thumbs: Thumb[], frame: number): Thumb | null {
  let best: Thumb | null = null;
  for (const t of thumbs) {
    if (t.frame <= frame && (best === null || t.frame > best.frame)) best = t;
  }
  if (best) return best;
  return thumbs.length > 0 ? thumbs[0] : null;
}

export function sameCuts(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function clampFrame(frame: number, numFrames: number): number {
  return Math.min(Math.max(frame, 0), Math.max(numFrames - 1, 0));
}

// ---------------------------------------------------------------- zooming

/** Visible slice of the filmstrip at a zoom level — a half-open frame range
 * [start, start + frames). At fit (zoom 1) it is the whole strip. */
export interface FrameWindow {
  start: number;
  frames: number;
}

/** Past this per-tile duration the server tiles only repeat, so tile
 * sourcing switches to frames extracted from the preview proxy. */
const EXTRACTION_COLUMN_SECONDS = 1.0;

/** Visible frames one viewport is expected to hold at the deepest zoom
 * (~10 s of 24 fps video). Bounds ONLY how deep zoomLevels goes — the
 * strip's tile count is fixed-pixel-width (planTiles below) and does not
 * depend on it. */
export const DEEPEST_ZOOM_VISIBLE_FRAMES = 240;

/** Hard ceiling on zoom depth — hour-plus sources reach the visible-frames
 * bound before this; anything longer keeps a sane strip width instead. */
export const MAX_ZOOM = 1024;

/** The frame window visible when the strip is zoomed `zoom`× and scrolled so
 * `scrollFraction` (scrollLeft / total zoomed width, 0..1-1/zoom) sits at the
 * left edge. `frames` is ceil so a fully scrolled window ends exactly at
 * numFrames (the last frame stays reachable). */
export function zoomedWindow(
  numFrames: number,
  zoom: number,
  scrollFraction: number,
): FrameWindow {
  const z = Math.max(zoom, 1);
  const frames = Math.max(1, Math.min(numFrames, Math.ceil(numFrames / z)));
  const maxStart = Math.max(numFrames - frames, 0);
  const start = Math.min(positionToFrame(scrollFraction, numFrames), maxStart);
  return { start, frames };
}

/** positionToFrame over a zoomed window: a 0..1 position across the VISIBLE
 * strip → absolute source-frame index (clamped, half-open). */
export function windowPositionToFrame(pos: number, win: FrameWindow): number {
  return win.start + positionToFrame(pos, win.frames);
}

/** frameToPosition over a zoomed window (frames outside clamp to 0/1). */
export function frameToWindowPosition(frame: number, win: FrameWindow): number {
  return frameToPosition(frame - win.start, win.frames);
}

/** Scroll fraction (scrollLeft / zoomed strip width) that centers `frame` in
 * the viewport at `zoom`, clamped to the scrollable range. */
export function scrollFractionToCenter(
  frame: number,
  numFrames: number,
  zoom: number,
): number {
  const z = Math.max(zoom, 1);
  const visible = 1 / z;
  const target = frameToPosition(frame, numFrames) - visible / 2;
  return Math.min(Math.max(target, 0), 1 - visible);
}

/** Zoom steps for the timeline: fit (1×) doubling to at least 16×, and deep
 * enough that the visible window holds ≤ DEEPEST_ZOOM_VISIBLE_FRAMES
 * (numFrames / zoom — ~10 s of video for frame-precise marker work),
 * capped at MAX_ZOOM. */
export function zoomLevels(numFrames: number): number[] {
  const levels: number[] = [];
  for (let z = 1; ; z *= 2) {
    levels.push(z);
    if (
      (z >= 16 && numFrames / z <= DEEPEST_ZOOM_VISIBLE_FRAMES) ||
      z >= MAX_ZOOM
    ) {
      break;
    }
  }
  return levels;
}

/** True when `zoom` is deep enough that stretching the ~100 server tiles
 * across the strip would leave each tile-width covering ≤
 * EXTRACTION_COLUMN_SECONDS of video — past the server tiles' resolution,
 * so tile sourcing switches to frames extracted from the preview proxy.
 * Fit (1×) always stays on server tiles. */
export function isExtractionZoom(
  zoom: number,
  tileCount: number,
  numFrames: number,
  fps: RationalFPS,
): boolean {
  if (zoom <= 1 || tileCount <= 0 || numFrames <= 0) return false;
  const columnSeconds = frameToSeconds(numFrames, fps) / (tileCount * zoom);
  return columnSeconds <= EXTRACTION_COLUMN_SECONDS;
}

// -------------------------------------------- fixed-width tile regime (NLE)

/** The filmstrip's rendered height in px (FilmstripTimeline's h-[90px]) —
 * with the video aspect it fixes the PIXEL width of one tile. */
export const STRIP_HEIGHT_PX = 90;

/** Compact-mode strip height (FilmstripTimeline's h-14 = 56px). */
export const COMPACT_STRIP_HEIGHT_PX = 56;

/** Tile aspect when the probe's dimensions are unknown. */
export const DEFAULT_TILE_ASPECT = 16 / 9;

/** Viewport width assumed when layout reports 0 (jsdom, SSR, pre-mount) —
 * keeps the tile plan deterministic in tests and sane before first paint. */
export const DEFAULT_VIEWPORT_PX = 960;

/** Tiles rendered beyond the visible window on each side, so small scrolls
 * land on already-planned (and, deep-zoomed, already-extracted) tiles. */
export const TILE_MARGIN = 4;

/** Pixel width of one filmstrip tile: strip height × the video's aspect
 * ratio (probe width/height), so a source frame drawn into the tile is
 * never squeezed — the professional-NLE convention. ~160 px for 16:9 at
 * the full strip height. */
export function tileWidthPx(
  aspect?: number,
  stripHeight: number = STRIP_HEIGHT_PX,
): number {
  const a = aspect !== undefined && aspect > 0 ? aspect : DEFAULT_TILE_ASPECT;
  return Math.max(1, Math.round(stripHeight * a));
}

/** One fixed-width strip tile, anchored at a PIXEL position of the zoomed
 * strip (index × tileW) and showing the frame at its START boundary — the
 * NLE convention. Thumbnails are context only; frame precision lives in
 * the windowed hit-testing helpers above, which know nothing of tiles. */
export interface FilmstripTile {
  /** tile ordinal in the full zoomed strip (stable render key) */
  index: number;
  /** the frame at the tile's start boundary — what the tile displays */
  frame: number;
  /** left edge, fraction of the full (zoomed) strip width */
  left: number;
  /** width, fraction of the full strip width (last tile clips to the end) */
  width: number;
}

/** Tiles to render for the VISIBLE viewport (± TILE_MARGIN), in
 * extraction-priority order: visible tiles first (left → right), then the
 * margins alternating outward. Rendering order is irrelevant (tiles are
 * absolutely positioned); the order feeds useFrameThumbs' queue.
 *
 * The zoomed strip is viewportPx × zoom pixels wide and is tiled by
 * fixed-width tiles, so one tile covers numFrames × tileW / (viewportPx ×
 * zoom) frames — frames-per-tile follows from zoom, tile COUNT per screen
 * stays ~viewportPx / tileW regardless of zoom. Each tile's frame comes
 * from positionToFrame at its left edge (no fps math, per the doctrine). */
export function planTiles(
  numFrames: number,
  zoom: number,
  scrollFraction: number,
  viewportPx: number,
  tileW: number,
): FilmstripTile[] {
  if (numFrames <= 0 || viewportPx <= 0 || tileW <= 0) return [];
  const stripPx = viewportPx * Math.max(zoom, 1);
  const lastTile = Math.ceil(stripPx / tileW) - 1;
  const scrollPx = Math.min(Math.max(scrollFraction, 0), 1) * stripPx;
  const first = Math.min(Math.floor(scrollPx / tileW), lastTile);
  const last = Math.min(Math.floor((scrollPx + viewportPx) / tileW), lastTile);
  const out: FilmstripTile[] = [];
  const push = (i: number) => {
    const left = (i * tileW) / stripPx;
    out.push({
      index: i,
      frame: positionToFrame(left, numFrames),
      left,
      width: Math.min(tileW / stripPx, 1 - left),
    });
  };
  for (let i = first; i <= last; i++) push(i);
  for (let d = 1; d <= TILE_MARGIN; d++) {
    if (first - d >= 0) push(first - d);
    if (last + d <= lastTile) push(last + d);
  }
  return out;
}
