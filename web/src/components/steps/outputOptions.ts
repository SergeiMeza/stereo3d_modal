/**
 * The ONE definition of the output options the Stereo and Deliver pages
 * sell — both pages offer the same resolution presets and the same format
 * set so the preview step previews exactly what production delivers.
 *
 * The API still accepts tb/half_tb, but the product no longer offers them —
 * do not add them back here.
 */

import type { Format, Inpaint, Preset } from "@/lib/api/types";

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

/** User-facing names for the API's inpaint modes. The wire values are
 * internal terms — a model name and a renderer detail — and must never
 * appear in UI copy: "propainter" fills the thin gaps that open along
 * object edges when the frame is shifted for each eye (the deliverable
 * look); "none" skips that fill ("splatted" internally) — cheaper, with
 * rough edges, fine for judging depth. */
export const INPAINT_LABELS: Record<Inpaint, string> = {
  propainter: "Full quality",
  none: "Quick",
};
