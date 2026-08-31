/**
 * The ONE definition of the output options the Stereo and Deliver pages
 * sell — both pages offer the same resolution presets and the same format
 * set so the preview step previews exactly what production delivers.
 *
 * The API still accepts tb/half_tb, but the product no longer offers them —
 * do not add them back here.
 */

import type { Format, Inpaint, Preset, Warp } from "@/lib/api/types";

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
  migan: "Fast fill",
  none: "Quick",
};

/** Edge handling: the user-facing choice that drives BOTH wire fields
 * (warp + inpaint). Values are UI-only — never sent on the wire. */
export type EdgeMode = "best" | "fast" | "stretched";
export const EDGE_OPTIONS: readonly EdgeMode[] = ["best", "fast", "stretched"];

export const EDGE_LABELS: Record<EdgeMode, string> = {
  best: "Filled edges — best",
  fast: "Filled edges — fast",
  stretched: "Stretched edges",
};

export const EDGE_HINT =
  "How the thin gaps that open along object edges are handled. Best paints them in with motion-aware fill — the deliverable look, slowest. Fast paints each frame independently — nearly as clean, much quicker and cheaper. Stretched pulls the neighbouring pixels across the gaps, the same method as the mobile app: the quickest of all.";

/** The wire fields an edge mode implies. Stretched = the backward warp
 * (which the gateway forces to inpaint none); the filled modes keep the
 * default forward warp, so no warp field goes on the wire. */
export function edgeModeRequest(mode: EdgeMode): { inpaint: Inpaint; warp?: Warp } {
  if (mode === "stretched") return { inpaint: "none", warp: "backward" };
  return { inpaint: mode === "fast" ? "migan" : "propainter" };
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

export const WARP_HINT =
  "How the thin gaps that open along object edges are handled. Filled edges paints them in — the deliverable look, slower. Stretched edges pulls the neighbouring pixels across them, the same method as the mobile app: quicker, with no fill pass.";

/** The inpaint value a warp choice implies. The gateway forces this
 * pairing (backward ⇒ none) and rejects backward + propainter, so the
 * UI never sends a contradiction. */
export function inpaintForWarp(warp: Warp): Inpaint {
  return warp === "backward" ? "none" : "propainter";
}
