"use client";

/**
 * StepReview — the ONE review area shared by the Depth / Stereo / Deliver
 * pages, so every step reviews its output the same way (the Cut tab's
 * layout): a frame-exact SOURCE preview (usePreviewPlayer over the project
 * proxy) with the Space/←/→ transport, an optional derived-output video
 * BESIDE it as a strict FOLLOWER of the same transport, a read-only
 * FilmstripTimeline (cut markers) for scrubbing, and a render-prop child for
 * the page's scene section (grid/rows) driven by the shared playhead.
 *
 * Follower sync (useFollowerVideo) hangs off the MASTER video's element
 * events — play/pause/ratechange mirror; seeked/timeupdate sync the position
 * by FRACTION of duration. Derived outputs run at their own fps; frame math
 * applies only to the source proxy (frame doctrine), so fraction-of-duration
 * is the only valid mapping. The follower always stays muted (audio belongs
 * to the master).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode, RefObject } from "react";

import { FilmstripTimeline } from "@/components/workspace/FilmstripTimeline";
import { PreviewViewer } from "@/components/workspace/PreviewViewer";
import { usePlayerShortcuts } from "@/components/workspace/usePlayerShortcuts";
import { usePreviewPlayer } from "@/components/workspace/usePreviewPlayer";
import { clampFrame } from "@/components/workspace/utils";
import type { Conversion, Project } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import type { RationalFPS } from "@/lib/frames";

import { PlayerBadge, videoDims, type VideoDims } from "./PlayerBadge";

/** A run's signed download links (name → URL), fetched once per conversion
 * id; null while loading or when there is no run. Errors resolve to an
 * empty map — the panels degrade to "no playable output" notes. */
export function useRunDownloads(
  conversion: Conversion | undefined,
): Record<string, string> | null {
  const client = useGateway();
  const id = conversion?.conversion_id ?? null;
  const [fetched, setFetched] = useState<{
    id: string;
    downloads: Record<string, string>;
  } | null>(null);

  useEffect(() => {
    if (id === null || fetched?.id === id) return;
    let cancelled = false;
    client
      .getDownloads(id)
      .then((d) => {
        if (!cancelled) setFetched({ id, downloads: d.downloads });
      })
      .catch(() => {
        if (!cancelled) setFetched({ id, downloads: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [client, id, fetched]);

  return id !== null && fetched?.id === id ? fetched.downloads : null;
}

/** Preference order for a browser-playable stereo output — SBS is the
 * primary review format. (mvhevc is never browser-decodable.) */
export const PLAYABLE_PREFERENCE = ["sbs", "half_sbs", "anaglyph"] as const;

/** The best browser-playable output of a downloads map, or null. */
export function bestPlayable(
  downloads: Record<string, string> | null,
): { name: string; url: string } | null {
  if (downloads === null) return null;
  const name = PLAYABLE_PREFERENCE.find((n) => downloads[n] !== undefined);
  return name ? { name, url: downloads[name] } : null;
}

/**
 * Keep a derived-output <video> a strict FOLLOWER of the master preview
 * video, off the master's own element events (so every transport path —
 * buttons, Space, timeline scrubs, scene-card jumps — is covered without
 * extra wiring): play/pause/ratechange mirror; seeked/timeupdate sync the
 * position by FRACTION of duration.
 */
export function useFollowerVideo(
  masterRef: RefObject<HTMLVideoElement | null>,
  followerRef: RefObject<HTMLVideoElement | null>,
  url: string | null,
): void {
  useEffect(() => {
    const m = masterRef.current;
    const f = followerRef.current;
    if (!m || !f || url === null) return;

    const sync = () => {
      if (!m.duration || !f.duration) return;
      const target = (m.currentTime / m.duration) * f.duration;
      // small tolerance so playback isn't stuttered by constant micro-seeks
      if (Math.abs(f.currentTime - target) > 0.15) f.currentTime = target;
    };
    const onPlay = () => {
      f.playbackRate = m.playbackRate;
      const p = f.play();
      if (p instanceof Promise) p.catch(() => {});
    };
    const onPause = () => {
      f.pause();
      sync();
    };
    const onRate = () => {
      f.playbackRate = m.playbackRate;
    };

    m.addEventListener("play", onPlay);
    m.addEventListener("pause", onPause);
    m.addEventListener("seeked", sync);
    m.addEventListener("timeupdate", sync);
    m.addEventListener("ratechange", onRate);
    // durations arrive asynchronously — sync once the follower has one
    f.addEventListener("loadedmetadata", sync);

    // Adopt the master's CURRENT state (it may already be playing when the
    // first run lands, or when an import swaps the follower element).
    f.muted = true;
    onRate();
    sync();
    if (!m.paused) onPlay();

    return () => {
      m.removeEventListener("play", onPlay);
      m.removeEventListener("pause", onPause);
      m.removeEventListener("seeked", sync);
      m.removeEventListener("timeupdate", sync);
      m.removeEventListener("ratechange", onRate);
      f.removeEventListener("loadedmetadata", sync);
      f.pause();
    };
  }, [masterRef, followerRef, url]);
}

export interface StepReviewContext {
  /** Source-frame playhead (drives scene highlights). */
  playhead: number;
  /** Seek the master (and thereby the follower) to a source frame. */
  scrub: (frame: number) => void;
}

export interface StepReviewFollower {
  url: string;
  /** Corner-badge label ("depth_vis", "sbs", "imported depth"). */
  label: string;
  /** Corner-badge tooltip. */
  title?: string;
  /** data-testid for the <video>; the badge gets `${testId}-badge`. */
  testId: string;
}

export interface StepReviewProps {
  project: Project;
  sourceFps: RationalFPS;
  /** Uppercase section heading ("Depth map", "Stereo preview"). */
  heading: string;
  /** Inline extras after the heading (hints, imported-file chip). */
  headingExtras?: ReactNode;
  /** Right-aligned header actions (Depth's Import/Export). */
  toolbar?: ReactNode;
  /** Derived-output video beside the source, synced to its transport. */
  follower?: StepReviewFollower | null;
  /** Aside slot content when there is a run but nothing playable — rendered
   * in a matching aspect-ratio box. */
  asideFallback?: { testId: string; content: ReactNode } | null;
  /** Scene section(s) under the timeline, driven by the shared playhead. */
  children?: (ctx: StepReviewContext) => ReactNode;
}

export function StepReview({
  project,
  sourceFps,
  heading,
  headingExtras,
  toolbar,
  follower = null,
  asideFallback = null,
  children,
}: StepReviewProps): JSX.Element {
  const probe = project.probe!;
  const numFrames = probe.num_frames;

  // Master: frame-exact preview player over the project proxy — same hook
  // the Cut tab uses. The playhead drives the timeline + scene highlights.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const handleVideoFrame = useCallback(
    (frame: number) => setPlayhead(clampFrame(frame, numFrames)),
    [numFrames],
  );
  const player = usePreviewPlayer(videoRef, sourceFps, handleVideoFrame);

  const scrub = useCallback(
    (frame: number) => {
      const f = clampFrame(frame, numFrames);
      setPlayhead(f);
      player.seekToFrame(f);
    },
    [numFrames, player],
  );
  const step = useCallback(
    (delta: number) => {
      player.pause();
      const f = clampFrame(playhead + delta, numFrames);
      setPlayhead(f);
      player.seekToFrame(f);
    },
    [numFrames, player, playhead],
  );

  const secondFrames = Math.max(1, Math.round(sourceFps.num / sourceFps.den));
  usePlayerShortcuts({ toggle: player.toggle, step, secondFrames });

  const followerRef = useRef<HTMLVideoElement | null>(null);
  useFollowerVideo(videoRef, followerRef, follower?.url ?? null);
  const [followerDims, setFollowerDims] = useState<VideoDims | null>(null);

  const aside = follower ? (
    <div
      className="relative w-full overflow-hidden rounded-md border border-edge bg-black"
      style={{ aspectRatio: `${probe.width} / ${probe.height}` }}
    >
      <video
        ref={followerRef}
        key={follower.url}
        src={follower.url}
        muted
        playsInline
        preload="auto"
        data-testid={follower.testId}
        onLoadedMetadata={(e) => setFollowerDims(videoDims(e))}
        className="absolute inset-0 h-full w-full select-none object-contain"
      />
      <PlayerBadge
        data-testid={`${follower.testId}-badge`}
        label={follower.label}
        dims={followerDims}
        title={follower.title}
      />
    </div>
  ) : asideFallback ? (
    <div
      data-testid={asideFallback.testId}
      className="flex w-full items-center justify-center rounded-md border border-edge bg-surface-1 p-4 text-center text-xs text-fg-muted"
      style={{ aspectRatio: `${probe.width} / ${probe.height}` }}
    >
      {asideFallback.content}
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex min-h-6 flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
          {heading}
        </h3>
        {headingExtras}
        {toolbar ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">{toolbar}</div>
        ) : null}
      </div>

      <PreviewViewer
        probe={probe}
        fps={sourceFps}
        playhead={playhead}
        previewUrl={project.preview_url}
        thumbs={project.strip_thumbs ?? []}
        player={player}
        videoRef={videoRef}
        onStep={step}
        aside={aside}
      />

      <FilmstripTimeline
        readOnly
        thumbs={project.strip_thumbs ?? []}
        numFrames={numFrames}
        fps={sourceFps}
        playhead={playhead}
        cuts={project.scenes?.cuts ?? []}
        previewUrl={project.preview_url}
        aspect={probe.width / probe.height}
        onScrub={scrub}
      />

      {children ? children({ playhead, scrub }) : null}
    </div>
  );
}
