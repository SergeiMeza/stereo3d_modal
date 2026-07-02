/**
 * PlayerBadge — the shared top-right corner badge on every player, naming
 * WHAT is on screen and its ACTUAL decoded size once loadedmetadata fires
 * (e.g. "depth_vis 1232×518", "source proxy 854×480", "sbs 1920×540").
 * Users couldn't tell a 480p proxy from the source — the badge says so.
 * The workspace PreviewViewer renders the same component with its
 * frame-doctrine tooltip on top.
 */

import type { JSX, SyntheticEvent } from "react";

export interface VideoDims {
  w: number;
  h: number;
}

/** Read the decoded dimensions off a video's loadedmetadata event (null
 * until the element actually knows them — audio-only/0×0 stays unlabeled). */
export function videoDims(
  e: SyntheticEvent<HTMLVideoElement>,
): VideoDims | null {
  const { videoWidth: w, videoHeight: h } = e.currentTarget;
  return w > 0 && h > 0 ? { w, h } : null;
}

export function PlayerBadge({
  label,
  dims,
  title,
  "data-testid": testId,
}: {
  /** What is playing ("sbs", "depth_vis", "source proxy",
   * "Preview Resolution"). */
  label: string;
  /** Decoded videoWidth×videoHeight — null/undefined until metadata. */
  dims?: VideoDims | null;
  /** Optional tooltip (PreviewViewer's frame-doctrine reassurance). */
  title?: string;
  "data-testid"?: string;
}): JSX.Element {
  return (
    <span
      data-testid={testId ?? "player-badge"}
      title={title}
      className="pointer-events-none absolute top-1.5 right-1.5 z-10 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-white/90"
    >
      {dims ? `${label} ${dims.w}×${dims.h}` : label}
    </span>
  );
}
