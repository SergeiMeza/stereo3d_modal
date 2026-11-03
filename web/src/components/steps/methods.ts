/**
 * Customer copy and options for the two ways a project is made 3D. One
 * source of truth for the method chooser, the header switch, History and
 * the Lifelike pages.
 *
 * Copy rules (owner, 2026-11-03): never name how either method works
 * inside (no model, technique or vendor names) — only what the customer
 * gets.
 */

import type { Format, Method, Preset } from "@/lib/api/types";

export const METHOD_LABELS: Record<Method, string> = {
  lifelike: "Lifelike 3D",
  classic: "Classic 3D",
};

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
  mvhevc: "Vision Pro spatial video",
  sbs: "Full side by side",
  half_sbs: "Half side by side",
};

/** Lifelike preview length: about 5 s of source from the chosen moment
 * (the gateway allows up to 10 s). */
export const LIFELIKE_PREVIEW_SECONDS = 5;

/** Outputs longer than this are offered as parts (15 minutes). */
export const SPLIT_MAX_SECONDS = 900;

/** "1 h 5 min" / "12 min" / "45 s" — a length the customer reads. */
export function formatLength(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Lifelike qualities with the short side each renders per eye. No Draft:
 * Lifelike is its own product and starts at 1080p. */
export const LIFELIKE_PRESETS: readonly {
  preset: Preset;
  label: string;
  shortSide: number;
}[] = [
  { preset: "1080p", label: "1080p", shortSide: 1080 },
  { preset: "qhd", label: "1440p", shortSide: 1440 },
  { preset: "3k", label: "3K", shortSide: 1620 },
  { preset: "4k", label: "4K", shortSide: 2160 },
];

/** The qualities a source can have: Lifelike never upscales (the gateway
 * 400s preset_above_source), so only those at or below the source's short
 * side; a source below 1080 still gets 1080p (rendered at source size). */
export function lifelikePresetsFor(
  probe: { width: number; height: number } | undefined,
): typeof LIFELIKE_PRESETS {
  const short = probe ? Math.min(probe.width, probe.height) : Infinity;
  return LIFELIKE_PRESETS.filter(
    (p) => p.preset === "1080p" || p.shortSide <= short,
  );
}

export function lifelikePresetLabel(preset: string | undefined): string {
  return LIFELIKE_PRESETS.find((p) => p.preset === preset)?.label ?? preset ?? "";
}

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
