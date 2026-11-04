/**
 * Watching in a headset browser (S3D-47): Apple Vision Pro Safari, Meta
 * Quest Browser and Pico Browser. The approach is the one Spatial Video
 * Studio's served headset page proved (HeadsetPageScript.swift):
 *
 * - Vision Pro Safari names itself a Mac, but a Mac has no touch and no
 *   WebXR — so a "Mac" with touch points and navigator.xr is the headset.
 *   It shows Vision Pro spatial video (MV-HEVC) in 3D only in full screen;
 *   inline it plays flat.
 * - Quest, Pico and Samsung Galaxy XR are told apart by their user agent
 *   (Galaxy XR: the model SM-I61x or "Android XR"; Chrome's reduced user
 *   agent may hide the model, so useClient also asks userAgentData). They show side by
 *   side in 3D once the user picks that mode in the browser's own player
 *   (a page can't switch it). Quest plays full side by side (owner
 *   2026-11-04), and half side by side at 4K and above (questSbsFormat);
 *   Pico and Galaxy XR full side by side.
 * - Full screen goes on the <video> itself, from the user's tap, with the
 *   webkit fallbacks; exiting goes through whichever API entered.
 *
 * A WebXR player is out of scope (a later option).
 */

import type { Format, Preset } from "@/lib/api/types";

/**
 * Owner decision 2026-11-04: Meta Quest plays full side by side, so Quest
 * gets the full side-by-side file up to and including this quality, and
 * half side by side above it. Full 4K side by side is 7680 px wide, and
 * older Quest 2 decoders may not play it. The owner's Quest test may move
 * this line: change it here only.
 */
export const QUEST_FULL_SBS_MAX_PRESET: Preset = "3k";

const PRESET_ORDER: readonly Preset[] = ["draft", "1080p", "qhd", "3k", "4k", "5k", "6k", "8k"];

/** The side-by-side file for Meta Quest at a quality: full up to
 * QUEST_FULL_SBS_MAX_PRESET, half above it (unknown quality: full). */
export function questSbsFormat(preset?: Preset | null): Format {
  if (!preset) return "sbs";
  return PRESET_ORDER.indexOf(preset) > PRESET_ORDER.indexOf(QUEST_FULL_SBS_MAX_PRESET) ? "half_sbs" : "sbs";
}

export type Client = "vision" | "quest" | "pico" | "galaxyxr" | "desktop";

interface NavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
  xr?: unknown;
}

/** Samsung Galaxy XR (model SM-I610) or any Android XR browser. */
export const GALAXY_XR = /SM-I61\d|Galaxy XR|Android XR/i;

/** Which headset browser (if any) this is. */
export function detectClient(nav: NavigatorLike | undefined = globalThis.navigator): Client {
  if (!nav) return "desktop";
  const ua = nav.userAgent ?? "";
  if (/OculusBrowser|Quest/i.test(ua)) return "quest";
  if (/Pico/i.test(ua)) return "pico";
  if (GALAXY_XR.test(ua)) return "galaxyxr";
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 0 && nav.xr) {
    return "vision";
  }
  return "desktop";
}

export function isHeadset(c: Client): boolean {
  return c !== "desktop";
}

/** The one format a headset's previews ask for, at a quality. */
export function headsetPreviewFormats(c: Exclude<Client, "desktop">, preset?: Preset | null): Format[] {
  switch (c) {
    case "vision":
      return ["mvhevc"];
    case "quest":
      return [questSbsFormat(preset)];
    default:
      return ["sbs"];
  }
}

/** The formats this client shows in 3D, best first; empty on a desktop. */
export function stereoFormatsFor(c: Client): Format[] {
  switch (c) {
    case "vision":
      return ["mvhevc"];
    case "quest":
      // owner 2026-11-04: full side by side first; a run that has only the
      // half file (4K and above) plays that
      return ["sbs", "half_sbs"];
    case "pico":
    case "galaxyxr":
      return ["sbs", "half_sbs"];
    default:
      return [];
  }
}

/** What full screen plays on a desktop or phone: a picture the browser
 * can play (side by side first, flat Vision Pro video last). */
const FLAT_ORDER: Format[] = ["sbs", "half_sbs", "anaglyph", "mvhevc"];

export interface PlayChoice {
  format: Format;
  url: string;
  /** true when this client shows it in 3D */
  stereo: boolean;
}

/** The file to play for this client from a run's files (format → URL). */
export function playChoice(
  c: Client,
  files: Partial<Record<string, string>>,
): PlayChoice | null {
  for (const f of stereoFormatsFor(c)) {
    const url = files[f];
    if (url) return { format: f, url, stereo: true };
  }
  for (const f of FLAT_ORDER) {
    const url = files[f];
    if (url) return { format: f, url, stereo: false };
  }
  return null;
}

/** The one-line hint under the button on Quest and Pico. */
export const HEADSET_HINT: Partial<Record<Client, string>> = {
  quest: "In the player's view options, choose 3D side by side.",
  pico: "In the player's mode menu, choose 3D left and right (side by side).",
  galaxyxr: "In the player, choose 3D side by side.",
};

interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitEnterFullscreen?: () => void;
}

/** Full screen on the element itself, from the user's tap; video gets the
 * browser's own controls while it lasts. */
export function enterFullscreen(el: HTMLElement): void {
  const e = el as FullscreenElement;
  if (el instanceof HTMLVideoElement) el.controls = true;
  const go = e.requestFullscreen ?? e.webkitRequestFullscreen ?? e.webkitEnterFullscreen;
  if (!go) return;
  try {
    const r = go.call(e) as Promise<void> | void;
    if (r && typeof (r as Promise<void>).catch === "function") {
      (r as Promise<void>).catch(() => {});
    }
  } catch {
    /* refused: the video still plays inline */
  }
}

interface WebkitDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}

export function isFullscreen(): boolean {
  const d = document as WebkitDocument;
  return Boolean(d.fullscreenElement || d.webkitFullscreenElement);
}

/** Leave full screen through whichever API entered it. */
export function exitFullscreen(video?: HTMLVideoElement | null): void {
  const d = document as WebkitDocument;
  try {
    if (d.fullscreenElement && d.exitFullscreen) void d.exitFullscreen().catch(() => {});
    else if (d.webkitFullscreenElement && d.webkitExitFullscreen) d.webkitExitFullscreen();
    else {
      const v = video as
        | (HTMLVideoElement & {
            webkitDisplayingFullscreen?: boolean;
            webkitExitFullscreen?: () => void;
          })
        | null
        | undefined;
      if (v?.webkitDisplayingFullscreen && v.webkitExitFullscreen) v.webkitExitFullscreen();
    }
  } catch {
    /* already out */
  }
}
