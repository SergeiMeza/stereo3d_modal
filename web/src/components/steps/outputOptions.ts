/**
 * The ONE definition of the output options the Stereo and Deliver pages
 * sell — both pages offer the same resolution presets and the same format
 * set so the preview step previews exactly what production delivers.
 *
 * The API still accepts tb/half_tb, but the product no longer offers them —
 * do not add them back here.
 */

import type { Format, Inpaint, Preset, Warp } from "@/lib/api/types";
import {
  EDGE_STYLE_NAMES,
  FORMAT_NAMES,
  QUALITIES,
  type EdgeMode,
} from "@/lib/glossary";
import { EN, type Tr } from "@/lib/i18n/t";

export type { EdgeMode };

/** Resolution presets (the resulting output resolution). depth_preview
 * ignores preset (always draft); Stereo and Deliver share this list. */
export const RESOLUTION_PRESETS: readonly Preset[] = QUALITIES;

/** Output formats sold in the UI, MV-HEVC included on BOTH steps (preview
 * what you deliver — Vision Pro / spatial players). */
export const OUTPUT_FORMATS = [
  "sbs",
  "half_sbs",
  "anaglyph",
  "mvhevc",
] as const satisfies readonly Format[];

/** Customer names (lib/glossary). */
export const FORMAT_LABELS: Record<(typeof OUTPUT_FORMATS)[number], string> = {
  sbs: FORMAT_NAMES.sbs,
  half_sbs: FORMAT_NAMES.half_sbs,
  anaglyph: FORMAT_NAMES.anaglyph,
  mvhevc: FORMAT_NAMES.mvhevc,
};

/** User-facing names for the API's inpaint modes. The wire values are
 * internal terms — a model name and a renderer detail — and must never
 * appear in UI copy: "propainter" fills the thin gaps that open along
 * object edges when the frame is shifted for each eye (the deliverable
 * look); "none" skips that fill ("splatted" internally) — cheaper, with
 * rough edges, fine for judging depth. */
export const INPAINT_LABELS: Record<Inpaint, string> = {
  propainter: "Full quality",
  migan: "Fast fill (no longer offered)",
  none: "Quick",
};

export function inpaintLabel(i: Inpaint, t: Tr = EN): string {
  return Object.hasOwn(INPAINT_LABELS, i) ? t(`make.output.inpaint.${i}`) : i;
}

/** Edge style (S3D-29): the user-facing choice that drives BOTH wire
 * fields (warp + inpaint). Two equal options in this order — Stretched,
 * then Filled, with Stretched preselected; which looks better is a matter
 * of taste, so the copy never ranks them. The per-frame fill ("migan") is no longer offered
 * (the API still accepts it). Values are UI-only — never on the wire. */
export const EDGE_OPTIONS: readonly EdgeMode[] = ["stretched", "filled"];

export const EDGE_LABELS: Record<EdgeMode, string> = EDGE_STYLE_NAMES;

export const EDGE_HINT =
  "Shifting the picture for each eye opens thin gaps along object edges. Stretched pulls the neighbouring pixels across them; Filled paints them in. Two different looks: pick the one you like.";

/** EDGE_HINT (and WARP_HINT) in the reader's language. */
export function edgeHint(t: Tr = EN): string {
  return t("make.output.edgeHint");
}

/** The wire fields an edge style implies. Stretched = the backward warp
 * with no fill; Filled keeps the default forward warp (no warp field on
 * the wire) with the video fill. */
export function edgeModeRequest(mode: EdgeMode): { inpaint: Inpaint; warp?: Warp } {
  if (mode === "stretched") return { inpaint: "none", warp: "backward" };
  return { inpaint: "propainter" };
}

/** legacy two-option list (kept for history rendering) */
export const WARP_OPTIONS: readonly Warp[] = ["forward", "backward"];

/** User-facing names for the API's warp methods. The wire values are
 * renderer terms ("forward"/"backward" warp, "splat"/"gather") and never
 * appear in copy. What they mean: shifting the frame for each eye opens
 * thin gaps along object edges — "forward" leaves them for a fill pass
 * to paint in (the default deliverable look); "backward" stretches the
 * neighbouring pixels across them instead — the same method as the mobile
 * app, one pass, no fill, so the run is quicker. */
export const WARP_LABELS: Record<Warp, string> = {
  forward: "Filled edges",
  backward: "Stretched edges",
};

export function warpLabel(w: Warp, t: Tr = EN): string {
  return t(`glossary.edges.${w === "backward" ? "stretched" : "filled"}`);
}

export const WARP_HINT =
  "Shifting the picture for each eye opens thin gaps along object edges. Stretched pulls the neighbouring pixels across them; Filled paints them in. Two different looks: pick the one you like.";

/** The inpaint value a warp choice implies. The gateway forces this
 * pairing (backward ⇒ none) and rejects backward + propainter, so the
 * UI never sends a contradiction. */
export function inpaintForWarp(warp: Warp): Inpaint {
  return warp === "backward" ? "none" : "propainter";
}
