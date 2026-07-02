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

  return (
    <section aria-label="Scenes" className="space-y-2">
      <h2 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
        Scenes · {ranges.length}
      </h2>
      {/* ~4 rows of cards before scrolling — 2 rows forced constant
          scrolling on typical (10+ scene) detections. */}
      <div className="grid max-h-[36rem] grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2 overflow-y-auto pr-1">
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
