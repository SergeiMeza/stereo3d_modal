/**
 * Customer copy and options for the two ways a project is made 3D. One
 * source of truth for the method chooser, the header switch, History and
 * the Lifelike pages.
 *
 * Copy rules (owner, 2026-11-03): never name how either method works
 * inside (no model, technique or vendor names) — only what the customer
 * gets.
 */

import type { Format, Method } from "@/lib/api/types";
import { FORMAT_NAMES, METHOD_NAMES } from "@/lib/glossary";

export const METHOD_LABELS: Record<Method, string> = METHOD_NAMES;

export const METHOD_DESCRIPTIONS: Record<Method, string> = {
  lifelike:
    "Rebuilds every moment of your video in 3D, then films it again for each eye. The most natural depth, clean edges, and faster results.",
  classic: "Adds depth to your original footage. Our original method.",
};

/** Chooser order: Lifelike first (recommended). */
export const METHOD_ORDER: readonly Method[] = ["lifelike", "classic"];

export const RECOMMENDED_METHOD: Method = "lifelike";

export const CHOOSER_TITLE = "How should we make it 3D?";
export const CHOOSER_SUBTITLE = "You can switch later. Same price either way.";

/** Lifelike output formats (the gateway 400s top-bottom and red-cyan for
 * Lifelike, so they are never offered). */
export const LIFELIKE_FORMATS = [
  "mvhevc",
  "sbs",
  "half_sbs",
] as const satisfies readonly Format[];

export const LIFELIKE_FORMAT_LABELS: Record<
  (typeof LIFELIKE_FORMATS)[number],
  string
> = {
  mvhevc: FORMAT_NAMES.mvhevc,
  sbs: FORMAT_NAMES.sbs,
  half_sbs: FORMAT_NAMES.half_sbs,
};

/** Lifelike preview length: about 5 s of source from the chosen moment
 * (the gateway allows up to 10 s). */
export const LIFELIKE_PREVIEW_SECONDS = 5;

/** Outputs longer than this are offered as parts (15 minutes). */
export const SPLIT_MAX_SECONDS = 900;


/** What the customer reads for 400 preset_above_source. */
export const PRESET_ABOVE_SOURCE =
  "That quality is higher than your video. Pick a lower one — we never upscale.";

/** Friendly copy for the gateway's method-related 400 codes on quotes and
 * runs; null for any other code (its own message is user-safe). */
export function methodErrorCopy(code: string): string | null {
  switch (code) {
    case "preset_above_source":
      return PRESET_ABOVE_SOURCE;
    case "method_unavailable":
      return "This 3D method isn't available right now. Please try again later, or switch methods at the top of the page.";
    case "source_too_long_for_method":
      return "This video is too long for Classic 3D. Switch to Lifelike 3D at the top of the page — it works with videos of any length.";
    case "step_not_supported_for_method":
      return "This project's 3D method has changed. Reload the page to continue.";
    case "split_unsupported":
      return "Splitting into parts isn't available for this method.";
    default:
      return null;
  }
}
