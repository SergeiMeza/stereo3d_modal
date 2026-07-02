"use client";

/**
 * Filmstrip timeline — zoomable strip of thumbnails with a playhead and
 * draggable scene-cut markers.
 *
 * Zooming: discrete levels from "fit" (whole video) doubling to zoomLevels'
 * max (a ~10 s visible window for frame-precise work). The inner strip is
 * zoom× the viewport width inside a native overflow-x scroller; zoom
 * (buttons or Cmd/Ctrl+scroll) recenters on the playhead, and the view
 * auto-follows the playhead whenever it MOVES out of the visible window
 * (playback, jumps) — plain user scrolling is never fought. Editable strips
 * START at the deepest zoom centered on the playhead (precision is the
 * point of the Cut page); readOnly strips start at Fit (context is the
 * point of Media).
 *
 * Tiles: the strip is tiled by FIXED-PIXEL-WIDTH tiles (strip height × the
 * video aspect, ~160 px — the professional-NLE look), each showing the
 * frame at its START boundary; frames-per-tile follows from zoom, and only
 * the tiles covering the visible viewport ± a margin are rendered
 * (absolutely positioned — never thousands of flex items). Sourcing: at
 * shallow zooms each tile shows the nearest of the ~100 server tiles; past
 * isExtractionZoom (a stretched server tile would cover ≤ ~1 s) tiles
 * switch to frame-exact thumbnails extracted client-side from the preview
 * proxy (useFrameThumbs), falling back to the nearest server tile while
 * pending. Thumbnails are context — hit-testing stays frame-exact below.
 *
 * Frame doctrine: pixel ↔ frame mapping goes exclusively through the
 * windowed composition of positionToFrame/frameToPosition (workspace utils
 * zoomedWindow/windowPositionToFrame), so click-scrub, double-click-add and
 * marker drags are frame-exact at every zoom. While dragging, the marker
 * shows a live frame + timecode label; the parent seeks the preview video
 * to the dragged frame. Clamping cut moves between neighbors is the
 * parent's job (single owner of the cut list).
 */

/* eslint-disable @next/next/no-img-element -- GCS thumbnails / extracted
   data-URLs at fixed strip height; next/image adds nothing for tiny
   repeated tiles. */

import { useAtom } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { Thumb } from "@/lib/api/types";
import { frameLabel, frameToPosition, type RationalFPS } from "@/lib/frames";
import { blurAfterMouseClick } from "@/lib/interactions";
import { timelineZoomIndexAtom } from "@/lib/viewerPrefs";

import { useFrameThumbs } from "./useFrameThumbs";
import {
  DEFAULT_VIEWPORT_PX,
  isExtractionZoom,
  nearestThumb,
  planTiles,
  scrollFractionToCenter,
  tileWidthPx,
  windowPositionToFrame,
  zoomedWindow,
  zoomLevels,
} from "./utils";

/** Accumulated wheel delta (px) per zoom step — a mouse notch (~100) steps
 * at once, a trackpad pinch needs a deliberate gesture per doubling.
 * Exported for tests. */
export const WHEEL_ZOOM_THRESHOLD = 80;

export interface FilmstripTimelineProps {
  thumbs: Thumb[];
  numFrames: number;
  fps: RationalFPS;
  playhead: number;
  /** Scene-cut markers. Omit for a marker-free strip (the read-only Media
   * page shows scrub + zoom only — cut furniture belongs to Cut). */
  cuts?: number[];
  /** frame-exact 1:1 proxy (Project.preview_url) — source for deep-zoom
   * extracted thumbnails; without it deep zoom repeats the server tiles. */
  previewUrl?: string;
  /** Video aspect ratio (probe width / height) — sets the fixed tile width
   * (strip height × aspect). Falls back to 16:9 when unknown. */
  aspect?: number;
  /** Context mode (Media page): any markers render inert (divs), no
   * double-click add, and the strip starts at Fit instead of max zoom.
   * Click-scrub and zooming stay available. */
  readOnly?: boolean;
  selectedIndex?: number | null;
  /** Click on the strip — move the playhead to the frame under the cursor. */
  onScrub: (frame: number) => void;
  /** Double-click on the strip — add a cut at the frame under the cursor. */
  onAddCut?: (frame: number) => void;
  onSelectCut?: (index: number) => void;
  /** Drag a marker — requested integer frame; parent clamps + applies and
   * seeks the preview video (throttled) to the dragged frame. */
  onMoveCut?: (index: number, frame: number) => void;
}

export function FilmstripTimeline({
  thumbs,
  numFrames,
  fps,
  playhead,
  cuts = [],
  previewUrl,
  aspect,
  readOnly = false,
  selectedIndex = null,
  onScrub,
  onAddCut,
  onSelectCut,
  onMoveCut,
}: FilmstripTimelineProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const levels = useMemo(() => zoomLevels(numFrames), [numFrames]);
  // The zoom level is a shared viewer pref (jotai) so it follows the user
  // across tabs. Until they zoom (null), each strip uses its own default:
  // editable strips open fully zoomed IN, centered on the playhead — the
  // Cut page is a precision tool; readOnly (Media) opens at Fit for context.
  const [storedZoomIndex, setZoomIndex] = useAtom(timelineZoomIndexAtom);
  const zoomIndex = Math.min(
    storedZoomIndex ?? (readOnly ? 0 : levels.length - 1),
    levels.length - 1,
  );
  const zoom = levels[zoomIndex];
  /** scrollLeft as a fraction of the zoomed strip width (0..1-1/zoom) —
   * the single source of truth for the visible window; the DOM scroll
   * position is synced to it (and updates it on user scrolls). At any
   * initial zoom past Fit the window opens centered on the playhead. */
  const [scrollFraction, setScrollFraction] = useState(() =>
    zoom === 1 ? 0 : scrollFractionToCenter(playhead, numFrames, zoom),
  );

  const frameWindow = zoomedWindow(numFrames, zoom, scrollFraction);

  // Viewport width in px — sizes the tile plan (how many fixed-width tiles
  // cover one screen). Measured off the scroller and kept fresh with a
  // ResizeObserver; jsdom (and pre-layout) reports 0, so a sane default
  // keeps the plan deterministic. Tiles are context-only, so a one-frame
  // lag after a resize is invisible.
  const [viewportPx, setViewportPx] = useState(DEFAULT_VIEWPORT_PX);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setViewportPx(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-follow: when the playhead MOVES outside the visible window
  // (playback, scene-card jumps), recenter on it. Guarded derived-state
  // pattern so user scrolling with a static playhead is never overridden.
  const [prevPlayhead, setPrevPlayhead] = useState(playhead);
  if (playhead !== prevPlayhead) {
    setPrevPlayhead(playhead);
    if (
      playhead < frameWindow.start ||
      playhead >= frameWindow.start + frameWindow.frames
    ) {
      setScrollFraction(scrollFractionToCenter(playhead, numFrames, zoom));
    }
  }

  // Sync the DOM scroll position to the fractional scroll state
  // (programmatic recenters after zoom changes / auto-follow).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    if (width <= 0) return;
    const target = scrollFraction * width * zoom;
    if (Math.abs(el.scrollLeft - target) > 1) el.scrollLeft = target;
  }, [scrollFraction, zoom]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const width = el.getBoundingClientRect().width;
    if (width <= 0) return;
    const max = Math.max(1 - 1 / zoom, 0);
    const frac = el.scrollLeft / (width * zoom);
    setScrollFraction(Math.min(Math.max(frac, 0), max));
  }

  function applyZoomStep(delta: number) {
    const next = Math.min(Math.max(zoomIndex + delta, 0), levels.length - 1);
    if (next === zoomIndex) return;
    setZoomIndex(next);
    // zoom is centered on the playhead
    setScrollFraction(scrollFractionToCenter(playhead, numFrames, levels[next]));
  }

  const applyZoomStepRef = useRef(applyZoomStep);
  useEffect(() => {
    applyZoomStepRef.current = applyZoomStep;
  });

  // Cmd/Ctrl + scroll zooms. Native listener: React registers wheel
  // handlers as passive, which would ignore preventDefault (page zoom).
  // Deltas ACCUMULATE to a threshold before stepping: each step doubles
  // the zoom, and a trackpad pinch emits dozens of small wheel events per
  // gesture — stepping per event blew through every level at once (user:
  // "ctrl + scroll is too sensitive"). One mouse-wheel notch (|deltaY|
  // ≈ 100+) still steps immediately; a direction flip discards the
  // opposite remainder so reversing feels instant.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let acc = 0;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // deltaMode 1 = lines (stepped mouse wheels on some browsers) —
      // normalize to ~pixels so the threshold means the same everywhere
      const delta = e.deltaY * (e.deltaMode === 1 ? 33 : 1);
      if (delta === 0) return;
      if (Math.sign(delta) !== Math.sign(acc)) acc = 0;
      acc += delta;
      if (Math.abs(acc) >= WHEEL_ZOOM_THRESHOLD) {
        applyZoomStepRef.current(acc < 0 ? 1 : -1);
        acc = 0;
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** Hit-testing: viewport position → absolute frame via the ZOOMED window. */
  function frameAtClientX(clientX: number): number {
    const el = scrollerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return windowPositionToFrame((clientX - rect.left) / rect.width, frameWindow);
  }

  // Tile plan (both regimes): fixed-pixel-width tiles for the visible
  // viewport ± margin, each anchored at its position in the zoomed strip
  // and showing the frame at its start boundary. Sourcing differs by zoom
  // depth: nearest server tile at shallow zooms; past isExtractionZoom the
  // tile's start frame is extracted client-side, with the server tile as
  // the fallback while pending (or permanently, on failure).
  const tileW = tileWidthPx(aspect);
  const tiles = useMemo(
    () => planTiles(numFrames, zoom, scrollFraction, viewportPx, tileW),
    [numFrames, zoom, scrollFraction, viewportPx, tileW],
  );
  const extractionMode =
    !!previewUrl && isExtractionZoom(zoom, thumbs.length, numFrames, fps);
  const wantedFrames = useMemo(
    () => (extractionMode ? tiles.map((t) => t.frame) : []),
    [extractionMode, tiles],
  );
  const extracted = useFrameThumbs(
    extractionMode ? previewUrl : undefined,
    fps,
    wantedFrames,
  );

  function startDrag(index: number, e: React.PointerEvent<HTMLButtonElement>) {
    dragIndexRef.current = index;
    setDragIndex(index);
    onSelectCut?.(index);
    // jsdom has no pointer capture; browsers keep move events on the marker.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function moveDrag(index: number, e: React.PointerEvent<HTMLButtonElement>) {
    if (dragIndexRef.current !== index) return;
    onMoveCut?.(index, frameAtClientX(e.clientX));
  }

  function endDrag(e: React.PointerEvent<HTMLButtonElement>) {
    dragIndexRef.current = null;
    setDragIndex(null);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] text-fg-muted">
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Zoom out"
          disabled={zoomIndex === 0}
          onClick={(e) => {
            blurAfterMouseClick(e);
            applyZoomStep(-1);
          }}
        >
          −
        </Button>
        <span data-testid="zoom-level" className="w-8 text-center font-mono">
          {zoom === 1 ? "Fit" : `${zoom}×`}
        </span>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Zoom in"
          disabled={zoomIndex === levels.length - 1}
          onClick={(e) => {
            blurAfterMouseClick(e);
            applyZoomStep(1);
          }}
        >
          +
        </Button>
        <span>⌘/Ctrl + scroll to zoom · scroll to pan</span>
      </div>

      <div
        ref={scrollerRef}
        data-testid="filmstrip"
        data-zoom={zoom}
        data-window-start={frameWindow.start}
        data-window-frames={frameWindow.frames}
        className="relative h-[90px] w-full cursor-crosshair overflow-x-auto overflow-y-hidden rounded-md border border-edge bg-surface-2 select-none"
        onScroll={handleScroll}
        onClick={(e) => onScrub(frameAtClientX(e.clientX))}
        onDoubleClick={
          readOnly ? undefined : (e) => onAddCut?.(frameAtClientX(e.clientX))
        }
      >
        <div className="relative h-full" style={{ width: `${zoom * 100}%` }}>
          <div
            data-testid="strip-tiles"
            className="pointer-events-none absolute inset-0"
          >
            {tiles.map((tile) => {
              const url =
                (extractionMode ? extracted.get(tile.frame) : undefined) ??
                nearestThumb(thumbs, tile.frame)?.url;
              return url ? (
                <img
                  key={tile.index}
                  src={url}
                  alt=""
                  draggable={false}
                  data-tile-frame={tile.frame}
                  data-extracted={
                    extractionMode && extracted.has(tile.frame)
                      ? "true"
                      : undefined
                  }
                  className="absolute inset-y-0 h-full object-cover"
                  style={{
                    left: `${tile.left * 100}%`,
                    width: `${tile.width * 100}%`,
                  }}
                />
              ) : null;
            })}
          </div>

          {cuts.map((frame, i) =>
            readOnly ? (
              <div
                key={i}
                data-testid="cut-marker"
                data-frame={frame}
                aria-hidden
                className="pointer-events-none absolute inset-y-0 z-10 w-[2px] -translate-x-1/2 bg-amber-400/80"
                style={{ left: `${frameToPosition(frame, numFrames) * 100}%` }}
              />
            ) : (
              <button
                key={i}
                type="button"
                data-testid="cut-marker"
                data-frame={frame}
                aria-label={`Cut at frame ${frame}`}
                aria-pressed={selectedIndex === i}
                className="group absolute inset-y-0 z-10 w-2 -translate-x-1/2 cursor-ew-resize touch-none appearance-none border-0 bg-transparent p-0"
                style={{ left: `${frameToPosition(frame, numFrames) * 100}%` }}
                onClick={(e) => {
                  e.stopPropagation();
                  blurAfterMouseClick(e);
                  onSelectCut?.(i);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => startDrag(i, e)}
                onPointerMove={(e) => moveDrag(i, e)}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <span
                  aria-hidden
                  className={`absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 ${
                    selectedIndex === i
                      ? "bg-primary shadow-[0_0_6px_var(--primary)]"
                      : "bg-amber-400/80 group-hover:bg-amber-300"
                  }`}
                />
                {dragIndex === i ? (
                  <span
                    data-testid="drag-label"
                    className="absolute top-1 left-1.5 z-30 rounded bg-black/80 px-1 py-0.5 font-mono text-[10px] whitespace-nowrap text-fg"
                  >
                    {frameLabel(frame, fps)}
                  </span>
                ) : null}
              </button>
            ),
          )}

          <div
            data-testid="playhead"
            aria-hidden
            className="pointer-events-none absolute inset-y-0 z-20 w-[2px] -translate-x-1/2 bg-fg"
            style={{ left: `${frameToPosition(playhead, numFrames) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
