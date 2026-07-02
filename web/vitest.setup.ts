/**
 * jsdom polyfills for Radix primitives (shadcn/ui): ResizeObserver (Slider),
 * Element.scrollIntoView (menus/dialogs), and window.matchMedia (vaul —
 * ui/drawer). No-ops / static results — layout observation is irrelevant
 * in jsdom.
 *
 * Also resets the shared jotai viewer prefs between tests: components use
 * jotai's DEFAULT store (module-scoped), so without a reset one test's
 * zoom/speed/mute would leak into the next within the same file.
 */

import { getDefaultStore } from "jotai";
import { afterEach } from "vitest";

import {
  compactPlayerAtom,
  compactTimelineAtom,
  mutedAtom,
  playbackSpeedAtom,
  timelineZoomIndexAtom,
} from "@/lib/viewerPrefs";

afterEach(() => {
  const store = getDefaultStore();
  store.set(playbackSpeedAtom, 1);
  store.set(mutedAtom, true);
  store.set(timelineZoomIndexAtom, null);
  store.set(compactPlayerAtom, false);
  store.set(compactTimelineAtom, false);
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

window.matchMedia ??= ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList) as typeof window.matchMedia;
