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
 *
 * Hover (owner 2026-11-07): a mouse or pen over the strip writes the frame
 * under it to stripHoverFrameAtom, and the strip draws a thin line with
 * the timecode (and the scene number when there are cuts); the preview
 * player above shows that frame (usePreviewPlayer) and goes back to its
 * own time and play state when the pointer leaves. A hover never moves
 * the playhead, the selection or the range — only a click does. Panning
 * or zooming under a resting pointer follows the frame now under it.
 * Touch has no hover: a tap is a click, a drag pans.
 *
 * Bands (owner 2026-11-07): spans the parent marks above the thumbnails
 * (the Preview page's past previews), in lanes so overlapping ones each
 * stay clickable; taller on coarse pointers. A click or Enter on a band
 * selects it and never scrubs; a click elsewhere on the strip scrubs as
 * before. Each band names itself in a tooltip.
 */

/* eslint-disable @next/next/no-img-element -- GCS thumbnails / extracted
   data-URLs at fixed strip height; next/image adds nothing for tiny
   repeated tiles. */

import { useAppAtom } from "@/lib/state/stores";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Thumb } from "@/lib/api/types";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import {
  frameLabel,
  frameToPosition,
  frameToTimecode,
  type RationalFPS,
} from "@/lib/frames";
import { blurAfterMouseClick } from "@/lib/interactions";
import {
  compactTimelineAtom,
  stripHoverFrameAtom,
  timelineZoomIndexAtom,
} from "@/lib/viewerPrefs";

import { useFrameThumbs } from "./useFrameThumbs";
import {
  COMPACT_STRIP_HEIGHT_PX,
  DEFAULT_VIEWPORT_PX,
  isExtractionZoom,
  nearestThumb,
  planTiles,
  scrollFractionToCenter,
  STRIP_HEIGHT_PX,
  tileWidthPx,
  windowPositionToFrame,
  zoomedWindow,
  zoomLevels,
} from "./utils";

/** Accumulated wheel delta (px) per zoom step — a mouse notch (~100) steps
 * at once, a trackpad pinch needs a deliberate gesture per doubling.
 * Exported for tests. */
export const WHEEL_ZOOM_THRESHOLD = 80;

/** The hover label: the timecode, with the scene number when the strip
 * has cuts (a cut at frame 0 starts nothing new). Exported for tests. */
export function hoverLabel(frame: number, fps: RationalFPS, cuts: number[], t: Tr = EN): string {
  const tc = frameToTimecode(frame, fps);
  if (cuts.length === 0) return tc;
  const scene = cuts.filter((c) => c > 0 && c <= frame).length + 1;
  return t("workspace.filmstrip.hoverScene", { scene: String(scene), timecode: tc });
}

/** A marked span above the thumbnails (a past preview). */
export interface StripBand {
  id: string;
  /** [from, to) source frames */
  from: number;
  to: number;
  /** done: finished; running: being made (pulses); failed: muted */
  state: "done" | "running" | "failed";
  /** the tooltip and accessible name, e.g. "0:14 – 0:19 · 1440p · Nov 7" */
  label: string;
  selected?: boolean;
}

/** A lane per band so overlapping bands sit one above the other (the
 * earliest-starting first, each in the lowest lane free at its start).
 * Exported for tests. */
export function bandLanes(bands: readonly { from: number; to: number }[]): number[] {
  const order = bands.map((_, i) => i).sort((a, b) => bands[a].from - bands[b].from);
  const laneEnds: number[] = [];
  const lanes = new Array<number>(bands.length).fill(0);
  for (const i of order) {
    let lane = laneEnds.findIndex((end) => end <= bands[i].from);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = bands[i].to;
    lanes[i] = lane;
  }
  return lanes;
}

function bandClass(b: StripBand): string {
  if (b.state === "failed") {
    return "border border-dashed border-fg-muted bg-fg-muted/40";
  }
  if (b.state === "running") {
    return "animate-pulse border border-emerald-300/70 bg-emerald-400/45";
  }
  return b.selected
    ? "border border-white bg-emerald-300 shadow-[0_0_6px_rgb(110_231_183/0.8)]"
    : "border border-emerald-200/80 bg-emerald-400/75 hover:bg-emerald-300";
}

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
  /** A highlighted [from, to) frame span — the Preview page's box. */
  range?: [number, number] | null;
  /** Click on the strip — move the playhead to the frame under the cursor. */
  onScrub: (frame: number) => void;
  /** Double-click on the strip — add a cut at the frame under the cursor. */
  onAddCut?: (frame: number) => void;
  onSelectCut?: (index: number) => void;
  /** Drag a marker — requested integer frame; parent clamps + applies and
   * seeks the preview video (throttled) to the dragged frame. */
  onMoveCut?: (index: number, frame: number) => void;
  /** Spans marked above the thumbnails (past previews). */
  bands?: StripBand[];
  /** A band clicked or chosen with the keyboard. */
  onSelectBand?: (id: string) => void;
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
  range = null,
  onScrub,
  onAddCut,
  onSelectCut,
  onMoveCut,
  bands = [],
  onSelectBand,
}: FilmstripTimelineProps) {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const levels = useMemo(() => zoomLevels(numFrames), [numFrames]);
  // The zoom level is a shared viewer pref (jotai) so it follows the user
  // across tabs. Until they zoom (null), each strip uses its own default:
  // editable strips open fully zoomed IN, centered on the playhead — the
  // Cut page is a precision tool; readOnly (Media) opens at Fit for context.
  const [storedZoomIndex, setZoomIndex] = useAppAtom(timelineZoomIndexAtom);
  const [compact, setCompact] = useAppAtom(compactTimelineAtom);
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

  // Hover: the frame under a resting mouse/pen (shared with the player).
  const [hoverFrame, setHoverFrame] = useAppAtom(stripHoverFrameAtom);
  const hoverXRef = useRef<number | null>(null);
  // a pan or zoom under a resting pointer: follow the frame now under it
  useEffect(() => {
    const x = hoverXRef.current;
    const el = scrollerRef.current;
    if (x === null || !el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    setHoverFrame(
      windowPositionToFrame(
        (x - rect.left) / rect.width,
        zoomedWindow(numFrames, zoom, scrollFraction),
      ),
    );
  }, [numFrames, zoom, scrollFraction, setHoverFrame]);
  // a strip that goes away mid-hover gives the player its time back
  useEffect(() => () => setHoverFrame(null), [setHoverFrame]);

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
  const tileW = tileWidthPx(
    aspect,
    compact ? COMPACT_STRIP_HEIGHT_PX : STRIP_HEIGHT_PX,
  );
  const tiles = useMemo(
    () => planTiles(numFrames, zoom, scrollFraction, viewportPx, tileW),
    [numFrames, zoom, scrollFraction, viewportPx, tileW],
  );
  const lanes = useMemo(() => bandLanes(bands), [bands]);
  const selectedBand = bands.find((b) => b.selected);

  const extractionMode =
    !!previewUrl && isExtractionZoom(zoom, thumbs.length, numFrames, fps);
  const wantedFrames = useMemo(
    () => (extractionMode ? tiles.map((tile) => tile.frame) : []),
    [extractionMode, tiles],
  );
  const extracted = useFrameThumbs(
    extractionMode ? previewUrl : undefined,
    fps,
    wantedFrames,
  );

  function hoverAt(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch" || dragIndexRef.current !== null) return;
    hoverXRef.current = e.clientX;
    setHoverFrame(frameAtClientX(e.clientX));
  }

  function endHover() {
    hoverXRef.current = null;
    setHoverFrame(null);
  }

  function startDrag(index: number, e: React.PointerEvent<HTMLButtonElement>) {
    // a marker drag drives the player itself
    endHover();
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
          aria-label={t("workspace.filmstrip.zoomOut")}
          disabled={zoomIndex === 0}
          onClick={(e) => {
            blurAfterMouseClick(e);
            applyZoomStep(-1);
          }}
        >
          −
        </Button>
        <span data-testid="zoom-level" className="w-8 text-center font-mono">
          {zoom === 1 ? t("workspace.filmstrip.fit") : `${zoom}×`}
        </span>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label={t("workspace.filmstrip.zoomIn")}
          disabled={zoomIndex === levels.length - 1}
          onClick={(e) => {
            blurAfterMouseClick(e);
            applyZoomStep(1);
          }}
        >
          +
        </Button>
        <span>{t("workspace.filmstrip.zoomHint")}</span>
        <Button
          variant="outline"
          size="xs"
          className="ml-auto"
          aria-pressed={compact}
          aria-label={
            compact ? t("workspace.filmstrip.fullHeightLabel") : t("workspace.filmstrip.compactLabel")
          }
          onClick={(e) => {
            blurAfterMouseClick(e);
            setCompact(!compact);
          }}
        >
          {compact ? t("workspace.filmstrip.fullStrip") : t("workspace.filmstrip.compactStrip")}
        </Button>
      </div>

      <div
        ref={scrollerRef}
        data-testid="filmstrip"
        data-zoom={zoom}
        data-window-start={frameWindow.start}
        data-window-frames={frameWindow.frames}
        className={`relative w-full cursor-crosshair overflow-x-auto overflow-y-hidden rounded-md border border-edge bg-surface-2 select-none ${
          compact ? "h-14" : "h-[90px]"
        }`}
        onScroll={handleScroll}
        onPointerMove={hoverAt}
        onPointerLeave={endHover}
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

          {selectedBand ? (
            <div
              data-testid="band-tint"
              aria-hidden
              className="pointer-events-none absolute inset-y-0 z-[5] bg-emerald-300/15"
              style={{
                left: `${frameToPosition(selectedBand.from, numFrames) * 100}%`,
                width: `${(frameToPosition(selectedBand.to, numFrames) - frameToPosition(selectedBand.from, numFrames)) * 100}%`,
              }}
            />
          ) : null}

          {bands.map((b, i) => (
            <Tooltip key={b.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-testid="strip-band"
                  data-band-id={b.id}
                  data-band-state={b.state}
                  data-lane={lanes[i]}
                  aria-pressed={b.selected === true}
                  aria-label={t("workspace.filmstrip.pastPreview", { label: b.label })}
                  className={`absolute z-[15] min-w-1.5 cursor-pointer rounded-sm p-0 [--lane-h:12px] pointer-coarse:[--lane-h:22px] ${bandClass(b)}`}
                  style={{
                    left: `${frameToPosition(b.from, numFrames) * 100}%`,
                    width: `${(frameToPosition(b.to, numFrames) - frameToPosition(b.from, numFrames)) * 100}%`,
                    top: `calc(${lanes[i]} * var(--lane-h) + 2px)`,
                    height: "calc(var(--lane-h) - 3px)",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    blurAfterMouseClick(e);
                    onSelectBand?.(b.id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                />
              </TooltipTrigger>
              <TooltipContent side="top">{b.label}</TooltipContent>
            </Tooltip>
          ))}

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
                aria-label={t("workspace.filmstrip.cutAt", { frame: String(frame) })}
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

          {range ? (
            <div
              data-testid="timeline-range"
              aria-hidden
              className="pointer-events-none absolute inset-y-0 z-10 rounded-sm border border-primary bg-primary/25"
              style={{
                left: `${frameToPosition(range[0], numFrames) * 100}%`,
                width: `${Math.max(0.4, (frameToPosition(range[1], numFrames) - frameToPosition(range[0], numFrames)) * 100)}%`,
              }}
            />
          ) : null}

          {hoverFrame !== null && hoverFrame < numFrames ? (
            <div
              data-testid="hover-line"
              data-frame={hoverFrame}
              aria-hidden
              className="pointer-events-none absolute inset-y-0 z-20 w-px -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.55)]"
              style={{ left: `${frameToPosition(hoverFrame, numFrames) * 100}%` }}
            >
              <span
                data-testid="hover-label"
                // under the bands when there are any
                className={`absolute ${bands.length > 0 ? "bottom-1" : "top-1"} rounded bg-black/80 px-1 py-0.5 font-mono text-[10px] whitespace-nowrap text-white ${
                  (hoverFrame - frameWindow.start) / Math.max(frameWindow.frames, 1) > 0.75
                    ? "right-1.5"
                    : "left-1.5"
                }`}
              >
                {hoverLabel(hoverFrame, fps, cuts, t)}
              </span>
            </div>
          ) : null}

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
