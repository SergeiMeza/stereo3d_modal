"use client";

/**
 * Session-wide viewer preferences, shared across the workspace tabs via
 * jotai's default store. The tab panels (Media / Cut / Depth / Stereo /
 * Deliver) unmount on every tab switch, so component-local state would
 * reset the playback speed, mute, and filmstrip zoom each time.
 *
 * Deliberately NOT persisted to localStorage: `muted` must default to true
 * on a fresh page load or autoplay is blocked, and a stale deep zoom from a
 * previous visit is more confusing than a clean default.
 */

import { atom } from "jotai";

/** video.playbackRate applied to every preview player. */
export const playbackSpeedAtom = atom(1);

/** Audio mute. Defaults TRUE (autoplay policy) — unmuting is always a user
 * gesture, which browsers allow; the choice then follows across tabs. */
export const mutedAtom = atom(true);

/** Filmstrip zoom-level index (see FilmstripTimeline's zoomLevels). null =
 * "never zoomed": each strip falls back to its own default (Fit on
 * read-only strips, deepest on editable ones). Strips clamp the stored
 * index to their own level count. */
export const timelineZoomIndexAtom = atom<number | null>(null);

/** Player layout: false = theater (full width, the default), true = compact
 * (height capped so the controls below stay on screen). */
export const compactPlayerAtom = atom(false);

/** Filmstrip layout: false = full-height strip, true = compact (shorter
 * strip, proportionally narrower tiles). */
export const compactTimelineAtom = atom(false);

/** The frame under the pointer on a filmstrip, or null when no strip is
 * hovered (owner 2026-11-07). The strip writes it; the preview player
 * beside the strip shows that frame and puts its own time back when it
 * goes null. Session viewer state like the prefs above, never persisted;
 * a hover never moves the playhead. */
export const stripHoverFrameAtom = atom<number | null>(null);
