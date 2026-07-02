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
