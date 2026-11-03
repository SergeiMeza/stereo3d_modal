/**
 * Watching in a headset browser (S3D-47): Apple Vision Pro Safari, Meta
 * Quest Browser and Pico Browser. The approach is the one Spatial Video
 * Studio's served headset page proved (HeadsetPageScript.swift):
 *
 * - Vision Pro Safari names itself a Mac, but a Mac has no touch and no
 *   WebXR — so a "Mac" with touch points and navigator.xr is the headset.
 *   It shows Vision Pro spatial video (MV-HEVC) in 3D only in full screen;
 *   inline it plays flat.
 * - Quest and Pico are told apart by their user agent. They show side by
 *   side in 3D once the user picks that mode in the browser's own player
 *   (a page can't switch it): half side by side on Quest (its browser
 *   unsqueezes it), full side by side on Pico.
 * - Full screen goes on the <video> itself, from the user's tap, with the
 *   webkit fallbacks; exiting goes through whichever API entered.
 *
 * A WebXR player is out of scope (a later option).
 */

import type { Format } from "@/lib/api/types";

export type Client = "vision" | "quest" | "pico" | "desktop";

interface NavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
  xr?: unknown;
}

/** Which headset browser (if any) this is. */
export function detectClient(nav: NavigatorLike | undefined = globalThis.navigator): Client {
  if (!nav) return "desktop";
  const ua = nav.userAgent ?? "";
  if (/OculusBrowser|Quest/i.test(ua)) return "quest";
  if (/Pico/i.test(ua)) return "pico";
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 0 && nav.xr) {
    return "vision";
  }
  return "desktop";
}

export function isHeadset(c: Client): boolean {
  return c !== "desktop";
}

/** The one format a headset's previews ask for. */
export const HEADSET_PREVIEW_FORMATS: Record<Exclude<Client, "desktop">, Format[]> = {
  vision: ["mvhevc"],
  quest: ["half_sbs"],
  pico: ["sbs"],
};

/** The formats this client shows in 3D, best first; empty on a desktop. */
export function stereoFormatsFor(c: Client): Format[] {
  switch (c) {
    case "vision":
      return ["mvhevc"];
    case "quest":
      return ["half_sbs", "sbs"];
    case "pico":
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
