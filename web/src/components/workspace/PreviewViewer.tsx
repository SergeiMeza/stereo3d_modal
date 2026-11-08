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
 * preview proxy the viewer falls back to the nearest strip thumbnail, and
 * so it does in China mode for a samples-CDN proxy, with the region notice.
 *
 * The shared PlayerBadge corner badge names what is on screen ("Preview
 * Resolution 854×480" from the video's ACTUAL videoWidth×videoHeight, or
 * "Thumbnail" for the fallback) — users couldn't tell they were watching
 * the 480p proxy, not the source. The tooltip reiterates the doctrine: the
 * proxy is frame-exact, and every conversion uses the full-resolution
 * source.
 */

/* eslint-disable @next/next/no-img-element -- fallback GCS thumbnail URLs. */

import { useAppAtom } from "@/lib/state/stores";
import { useState, type ReactNode, type RefObject } from "react";

import { SampleRegionNotice, useSampleBlocked } from "@/components/SampleRegionNotice";
import { PlayerBadge } from "@/components/steps/PlayerBadge";
import { MuteToggle, SpeedSelect } from "@/components/steps/ScenePicker";
import { Button } from "@/components/ui/button";
import type { Probe, Thumb } from "@/lib/api/types";
import { frameLabel, type RationalFPS } from "@/lib/frames";
import { useT } from "@/lib/i18n/I18nProvider";
import { blurAfterMouseClick } from "@/lib/interactions";
import { compactPlayerAtom } from "@/lib/viewerPrefs";

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
  previewUrl: givenPreviewUrl,
  thumbs,
  crop,
  player,
  videoRef,
  onStep,
  aside,
}: PreviewViewerProps) {
  const t = useT();
  // China mode: a samples-CDN proxy can't load, so the thumbnail shows
  // with the region notice over it (the sample project's thumbnails are
  // on the web's own origin)
  const blocked = useSampleBlocked(givenPreviewUrl);
  const previewUrl = blocked ? undefined : givenPreviewUrl;
  const cropRect = parseCrop(crop);
  const fallback = previewUrl ? null : nearestThumb(thumbs, playhead);
  // The proxy's real decoded dimensions, read off the element at
  // loadedmetadata — never hardcoded (short side is ~480 but width varies).
  const [proxyDims, setProxyDims] = useState<{ w: number; h: number } | null>(
    null,
  );
  // Theater (default) spans the full page width; compact caps the player at
  // ~30% of the viewport height so the timeline and controls below stay on
  // screen. The box is aspect-ratio-sized off its width, so the cap is a
  // width limit: 30vh × aspect per player (the aside doubles it, + gap-2).
  const [compact, setCompact] = useAppAtom(compactPlayerAtom);
  const aspect = probe.width / probe.height;
  const compactMaxWidth = aside
    ? `calc(60vh * ${aspect} + 0.5rem)`
    : `calc(30vh * ${aspect})`;

  return (
    // owner 2026-11-07: the video and its scrubber stay left to right
    <div dir="ltr" className="space-y-2">
      <div
        className={[
          aside ? "grid gap-2 sm:grid-cols-2" : "",
          compact ? "mx-auto w-full" : "",
        ].join(" ")}
        style={compact ? { maxWidth: compactMaxWidth } : undefined}
      >
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
              alt={t("workspace.viewer.thumbAlt", { frame: String(fallback.frame) })}
              draggable={false}
              className="absolute inset-0 h-full w-full select-none object-cover"
            />
          ) : null}
          {previewUrl || fallback ? (
            <PlayerBadge
              data-testid="proxy-badge"
              label={previewUrl ? t("workspace.viewer.previewResolution") : t("workspace.viewer.thumbnail")}
              dims={previewUrl ? proxyDims : null}
              title={t("workspace.viewer.proxyTitle", { size: `${probe.width}×${probe.height}` })}
            />
          ) : null}
          {blocked ? (
            <SampleRegionNotice className="absolute inset-x-0 bottom-0 bg-black/70 px-3 py-2 text-center text-xs text-white" />
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
          aria-label={player.playing ? t("workspace.viewer.pauseLabel") : t("workspace.viewer.playLabel")}
          disabled={!previewUrl}
          onClick={(e) => {
            blurAfterMouseClick(e);
            player.toggle();
          }}
        >
          {player.playing ? t("workspace.viewer.pause") : t("workspace.viewer.play")}
        </Button>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={t("workspace.viewer.stepBack")}
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
            aria-label={t("workspace.viewer.stepForward")}
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
            {t("workspace.viewer.activePicture", { size: `${cropRect.width}×${cropRect.height}` })}
          </span>
        ) : null}
        <Button
          variant="outline"
          size="xs"
          className="ms-auto"
          aria-pressed={compact}
          aria-label={compact ? t("workspace.viewer.theaterLabel") : t("workspace.viewer.compactLabel")}
          onClick={(e) => {
            blurAfterMouseClick(e);
            setCompact(!compact);
          }}
        >
          {compact ? t("workspace.viewer.theater") : t("workspace.viewer.compact")}
        </Button>
        <span className="text-xs text-fg-muted">{t("workspace.viewer.keysHint")}</span>
      </div>
    </div>
  );
}
