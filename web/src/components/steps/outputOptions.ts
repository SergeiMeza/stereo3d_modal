/**
 * The ONE definition of the output options the Stereo and Deliver pages
 * sell — both pages offer the same resolution presets and the same format
 * set so the preview step previews exactly what production delivers.
 *
 * The API still accepts tb/half_tb, but the product no longer offers them —
 * do not add them back here.
 */

import type { Format, Preset } from "@/lib/api/types";

/** Resolution presets (the resulting output resolution). depth_preview
 * ignores preset (always draft); Stereo and Deliver share this list. */
export const RESOLUTION_PRESETS: readonly Preset[] = ["1080p", "qhd", "3k", "4k"];

/** Output formats sold in the UI, MV-HEVC included on BOTH steps (preview
 * what you deliver — Vision Pro / spatial players). */
export const OUTPUT_FORMATS = [
  "sbs",
  "half_sbs",
  "anaglyph",
  "mvhevc",
] as const satisfies readonly Format[];

export const FORMAT_LABELS: Record<(typeof OUTPUT_FORMATS)[number], string> = {
  sbs: "SBS",
  half_sbs: "Half-SBS",
  anaglyph: "Anaglyph",
  mvhevc: "MV-HEVC",
};
