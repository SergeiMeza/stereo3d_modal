"use client";

/**
 * Preview viewer — real video playback of the project's frame-exact proxy
 * (Project.preview_url) with play/pause, ±1-frame stepping, the frameLabel
 * readout, and the detected active-picture (crop) region overlaid.
 *
 * Playback/seeking is owned by usePreviewPlayer in the parent (which also
 * needs it for Space and marker-drag seeks); this component renders the
 * <video> into the parent's ref and the transport controls.
 *
 * Crop coordinates are in SOURCE pixels ("W:H:X:Y"); the container is fixed
 * to the source aspect ratio, so pure percentages of the source dimensions
 * scale the overlay exactly at any display size. When a project has no
 * preview proxy the viewer falls back to the nearest strip thumbnail.
 *
 * The shared PlayerBadge corner badge names what is on screen ("Preview
 * Resolution 854×480" from the video's ACTUAL videoWidth×videoHeight, or
 * "Thumbnail" for the fallback) — users couldn't tell they were watching
 * the 480p proxy, not the source. The tooltip reiterates the doctrine: the
 * proxy is frame-exact, and every conversion uses the full-resolution
 * source.
 */

/* eslint-disable @next/next/no-img-element -- fallback GCS thumbnail URLs. */

import { useState, type ReactNode, type RefObject } from "react";

import { PlayerBadge } from "@/components/steps/PlayerBadge";
import { MuteToggle, SpeedSelect } from "@/components/steps/ScenePicker";
import { Button } from "@/components/ui/button";
import type { Probe, Thumb } from "@/lib/api/types";
import { frameLabel, type RationalFPS } from "@/lib/frames";
import { blurAfterMouseClick } from "@/lib/interactions";

import type { PreviewPlayer } from "./usePreviewPlayer";
import { nearestThumb, parseCrop } from "./utils";

export interface PreviewViewerProps {
  probe: Probe;
  fps: RationalFPS;
  playhead: number;
  /** frame-exact 1:1 proxy of the source (Project.preview_url) */
  previewUrl?: string;
  /** strip tiles — static fallback when the project has no preview proxy */
  thumbs: Thumb[];
  crop?: string;
  player: PreviewPlayer;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Step the playhead by a signed number of frames (parent pauses+seeks). */
  onStep: (deltaFrames: number) => void;
  /** Companion panel rendered BESIDE the video (Depth's depth-map player),
   * sharing this viewer's transport row. The parent styles it — typically a
   * matching aspect-ratio box with its own <video> synced to videoRef. */
  aside?: ReactNode;
}

export function PreviewViewer({
  probe,
  fps,
  playhead,
  previewUrl,
  thumbs,
  crop,
  player,
  videoRef,
  onStep,
  aside,
}: PreviewViewerProps) {
  const cropRect = parseCrop(crop);
  const fallback = previewUrl ? null : nearestThumb(thumbs, playhead);
  // The proxy's real decoded dimensions, read off the element at
  // loadedmetadata — never hardcoded (short side is ~480 but width varies).
  const [proxyDims, setProxyDims] = useState<{ w: number; h: number } | null>(
    null,
  );

  return (
    <div className="space-y-2">
      <div className={aside ? "grid gap-2 sm:grid-cols-2" : undefined}>
        <div
          className="relative w-full overflow-hidden rounded-md border border-edge bg-black"
          style={{ aspectRatio: `${probe.width} / ${probe.height}` }}
        >
          {previewUrl ? (
            <video
              ref={videoRef}
              data-testid="preview-video"
              src={previewUrl}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={(e) =>
                setProxyDims({
                  w: e.currentTarget.videoWidth,
                  h: e.currentTarget.videoHeight,
                })
              }
              className="absolute inset-0 h-full w-full select-none object-cover"
            />
          ) : fallback ? (
            <img
              data-testid="viewer-frame"
              data-thumb-frame={fallback.frame}
              src={fallback.url}
              alt={`nearest thumbnail, frame ${fallback.frame}`}
              draggable={false}
              className="absolute inset-0 h-full w-full select-none object-cover"
            />
          ) : null}
          {previewUrl || fallback ? (
            <PlayerBadge
              data-testid="proxy-badge"
              label={previewUrl ? "Preview Resolution" : "Thumbnail"}
              dims={previewUrl ? proxyDims : null}
              title={`Frame-exact preview proxy — conversions always use the full-resolution source (${probe.width}×${probe.height})`}
            />
          ) : null}
          {cropRect ? (
            <div
              data-testid="crop-overlay"
              aria-hidden
              className="pointer-events-none absolute border-2 border-primary/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
              style={{
                left: `${(cropRect.x / probe.width) * 100}%`,
                top: `${(cropRect.y / probe.height) * 100}%`,
                width: `${(cropRect.width / probe.width) * 100}%`,
                height: `${(cropRect.height / probe.height) * 100}%`,
              }}
            />
          ) : null}
        </div>
        {aside}
      </div>

      {/* Transport row — same shapes as the step players (ScenePicker.tsx):
          outline xs buttons, shared SpeedSelect, font-mono readouts. */}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="xs"
          className="w-20"
          aria-label={player.playing ? "Pause preview" : "Play preview"}
          disabled={!previewUrl}
          onClick={(e) => {
            blurAfterMouseClick(e);
            player.toggle();
          }}
        >
          {player.playing ? "❚❚ Pause" : "▶ Play"}
        </Button>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="Step back one frame"
            onClick={(e) => {
              blurAfterMouseClick(e);
              onStep(-1);
            }}
          >
            ◀
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="Step forward one frame"
            onClick={(e) => {
              blurAfterMouseClick(e);
              onStep(1);
            }}
          >
            ▶
          </Button>
        </div>
        <SpeedSelect
          id="preview-speed"
          value={player.speed}
          onChange={player.setSpeed}
        />
        <MuteToggle
          muted={player.muted}
          onChange={player.setMuted}
          disabled={!previewUrl}
        />
        <span data-testid="frame-readout" className="font-mono text-xs text-fg">
          {frameLabel(playhead, fps)}
        </span>
        {cropRect ? (
          <span className="text-xs text-fg-muted">
            active picture {cropRect.width}×{cropRect.height}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-fg-muted">
          Space play/pause · ←/→ ±1 frame · Shift ±1 s
        </span>
      </div>
    </div>
  );
}
