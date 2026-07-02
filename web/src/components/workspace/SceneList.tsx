"use client";

/**
 * Scene list — one card per scene implied by the current cut list
 * (cutsToRanges: half-open ranges tiling [0, numFrames)). Clicking a card
 * moves the playhead to the scene's first frame; the scene containing the
 * playhead is highlighted.
 *
 * Every scene except the first offers "Merge ←": remove the cut at the
 * scene's `start` frame, folding it into the previous scene (the fix for
 * over-segmented detections — e.g. two black scenes that are really one).
 * The card and the merge control are SIBLINGS in a relative wrapper, not
 * nested buttons (invalid HTML). Presentational: the parent owns the cut
 * list and does the actual removal via onMergeScene.
 */

/* eslint-disable @next/next/no-img-element -- signed GCS thumbnail URLs. */

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import type { Thumb } from "@/lib/api/types";
import {
  cutsToRanges,
  frameToTimecode,
  type RationalFPS,
} from "@/lib/frames";
import { blurAfterMouseClick } from "@/lib/interactions";

export interface SceneListProps {
  cuts: number[];
  numFrames: number;
  fps: RationalFPS;
  sceneThumbs: Thumb[];
  playhead: number;
  onSelectScene: (startFrame: number) => void;
  /** Remove the cut at `startFrame` (the scene's first frame), merging the
   * scene into the previous one. Omitted ⇒ no merge buttons (read-only). */
  onMergeScene?: (startFrame: number) => void;
}

/**
 * Scroll the active scene card (the one containing the playhead) to the top
 * of its scroll container as the video plays / timeline is scrubbed, so its
 * row leads the list. Keyed on the active scene's start frame so it only
 * scrolls when the playhead crosses into a new scene, not on every frame
 * within the same scene. Shared by the Cut tab's SceneList and the Depth /
 * Stereo scene sections — all render `scene-card` elements with data-start.
 */
export function useScrollActiveSceneToTop(
  scrollRef: RefObject<HTMLElement | null>,
  activeStart: number | undefined,
): void {
  useEffect(() => {
    if (activeStart == null) return;
    const container = scrollRef.current;
    const card = container?.querySelector<HTMLElement>(
      `[data-testid="scene-card"][data-start="${activeStart}"]`,
    );
    // jsdom implements neither element scrollTo nor layout — skip there.
    if (!container || !card || typeof container.scrollTo !== "function") return;
    // Position relative to the container's scroll origin. Measure via
    // bounding rects rather than offsetTop: the card's offsetParent is its
    // own `relative` wrapper, so offsetTop would be ~0, not the offset within
    // the scroll container. Always align the active row to the top (clamped by
    // the browser to the max scroll range for rows near the end).
    const containerRect = container.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cardTop = cardRect.top - containerRect.top + container.scrollTop;
    container.scrollTo({ top: cardTop, behavior: "smooth" });
  }, [scrollRef, activeStart]);
}

export function SceneList({
  cuts,
  numFrames,
  fps,
  sceneThumbs,
  playhead,
  onSelectScene,
  onMergeScene,
}: SceneListProps) {
  const ranges = cutsToRanges(cuts, numFrames);

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeStart = ranges.find(
    ([start, end]) => playhead >= start && playhead < end,
  )?.[0];
  useScrollActiveSceneToTop(scrollRef, activeStart);

  return (
    <section aria-label="Scenes" className="space-y-2">
      <h2 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
        Scenes · {ranges.length}
      </h2>
      {/* ~2 rows of cards before scrolling. */}
      <div
        ref={scrollRef}
        className="grid max-h-[18rem] grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2 overflow-y-auto pr-1"
      >
        {ranges.map(([start, end], i) => {
          const active = playhead >= start && playhead < end;
          const thumb = sceneThumbs.find(
            (t) => t.frame >= start && t.frame < end,
          );
          return (
            <div key={`${start}-${end}`} className="relative">
              <button
                type="button"
                data-testid="scene-card"
                data-start={start}
                data-end={end}
                aria-current={active ? "true" : undefined}
                onClick={(e) => {
                  blurAfterMouseClick(e);
                  onSelectScene(start);
                }}
                className={`w-full rounded-md border p-1.5 text-left transition-colors ${
                  active
                    ? "border-primary bg-surface-2 ring-1 ring-primary"
                    : "border-edge bg-surface-1 hover:bg-surface-2"
                }`}
              >
                <div className="mb-1 aspect-video w-full overflow-hidden rounded bg-black">
                  {thumb ? (
                    <img
                      src={thumb.url}
                      alt={`scene ${i + 1} keyframe`}
                      draggable={false}
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-fg">Scene {i + 1}</span>
                  <span className="font-mono text-[11px] text-fg-muted">
                    f{start}–f{end}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-fg-muted">
                  {frameToTimecode(start, fps)}
                </div>
              </button>
              {i > 0 && onMergeScene ? (
                <button
                  type="button"
                  data-testid="merge-scene"
                  data-start={start}
                  aria-label={`Merge scene ${i + 1} into the previous scene`}
                  title={`Remove the cut at frame ${start}, merging this scene into scene ${i}`}
                  onClick={(e) => {
                    blurAfterMouseClick(e);
                    onMergeScene(start);
                  }}
                  className="absolute top-2.5 right-2.5 z-10 rounded border border-edge bg-black/60 px-1.5 py-0.5 text-[10px] text-fg-muted hover:bg-black/80 hover:text-fg"
                >
                  Merge ←
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
