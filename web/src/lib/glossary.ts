/**
 * One name for each thing (S3D-37). Every page, the Files list, History,
 * the landing page and tests read customer-facing names for formats,
 * qualities, methods, steps and edge modes from here — never the wire
 * values ("mvhevc", "qhd", "propainter").
 */

import type { Format, Inpaint, Method, Params, Preset, Step, Warp } from "@/lib/api/types";

/** Output formats (S3D-08: top-bottom isn't sold; the names stay for old
 * runs that have it). */
export const FORMAT_NAMES: Record<Format, string> = {
  mvhevc: "Vision Pro spatial video",
  sbs: "Side by side",
  half_sbs: "Side by side (half size)",
  anaglyph: "Red-cyan",
  tb: "Top-bottom",
  half_tb: "Top-bottom (half size)",
};

/** Non-format outputs a Classic run can have. */
const OTHER_OUTPUT_NAMES: Record<string, string> = {
  depth: "Depth video",
  depth_vis: "Depth video (preview)",
};

/** The customer name of an output key; split parts read "… · Part 2". */
export function outputName(key: string): string {
  const m = /^(.+)_part(\d+)$/.exec(key);
  const base = m ? m[1] : key;
  const name =
    FORMAT_NAMES[base as Format] ?? OTHER_OUTPUT_NAMES[base] ?? base;
  return m ? `${name} · Part ${Number(m[2])}` : name;
}

export function formatName(f: string): string {
  return FORMAT_NAMES[f as Format] ?? OTHER_OUTPUT_NAMES[f] ?? f;
}

/** Qualities (presets): 1080p · 1440p · 3K · 4K. Draft exists only in the
 * API and old runs. */
export const QUALITY_NAMES: Record<Preset, string> = {
  draft: "Draft",
  "1080p": "1080p",
  qhd: "1440p",
  "3k": "3K",
  "4k": "4K",
};

/** Output short side per eye of each quality. */
export const QUALITY_SHORT_SIDE: Record<Preset, number> = {
  draft: 1080,
  "1080p": 1080,
  qhd: 1440,
  "3k": 1620,
  "4k": 2160,
};

/** Qualities offered on the pages (no Draft), in order. */
export const QUALITIES: readonly Preset[] = ["1080p", "qhd", "3k", "4k"];

export function qualityName(p: string | undefined): string {
  if (p === undefined) return "";
  return QUALITY_NAMES[p as Preset] ?? p;
}

/** Qualities a source can have (S3D-04): at or below its short side; a
 * source below 1080 still gets 1080p. Both methods. */
export function qualitiesFor(
  probe: { width: number; height: number } | undefined,
): Preset[] {
  const short = probe ? Math.min(probe.width, probe.height) : Infinity;
  return QUALITIES.filter(
    (p) => p === "1080p" || QUALITY_SHORT_SIDE[p] <= short,
  );
}

export const METHOD_NAMES: Record<Method, string> = {
  lifelike: "Lifelike 3D",
  classic: "Classic 3D",
};

/** What a run made, in words. */
export const STEP_NAMES: Record<Step, string> = {
  depth_preview: "Depth preview",
  stereo_preview: "3D look preview",
  lifelike_preview: "Preview",
  production: "Full video",
};

/** Classic edge handling (S3D-29: Best is the default; the others live
 * under Advanced). */
export type EdgeMode = "best" | "fast" | "stretched";

export const EDGE_NAMES: Record<EdgeMode | "none", string> = {
  best: "Best edges",
  fast: "Fast edges",
  stretched: "Stretched edges",
  none: "Unfilled edges",
};

/** The edge mode a run's (inpaint, warp) pair stands for. */
export function edgeModeOf(p: {
  inpaint?: Inpaint;
  warp?: Warp;
}): EdgeMode | "none" | null {
  if (p.warp === "backward") return "stretched";
  if (p.inpaint === "propainter") return "best";
  if (p.inpaint === "migan") return "fast";
  if (p.inpaint === "none") return "none";
  return null;
}

/** A run's settings in words: "4K · Vision Pro spatial video + Side by
 * side · Best edges". Classic knobs only when the run carried them. */
export function runSummary(p: Params, step?: Step): string {
  // a depth preview makes a depth video: its formats/edges are defaults
  // it never used
  if (step === "depth_preview" || p.depth_only) {
    return [STEP_NAMES.depth_preview, p.target_fps ? `${p.target_fps} fps` : null]
      .filter(Boolean)
      .join(" · ");
  }
  const edge = edgeModeOf(p);
  return [
    p.preset ? qualityName(p.preset) : null,
    p.formats?.length ? p.formats.map(formatName).join(" + ") : null,
    edge ? EDGE_NAMES[edge] : null,
    p.depth_scale !== undefined && p.depth_scale !== 1
      ? `3D strength ×${p.depth_scale.toFixed(2)}`
      : null,
    p.scene_overrides?.length
      ? `${p.scene_overrides.length} scene${p.scene_overrides.length === 1 ? "" : "s"} adjusted`
      : null,
    p.split_max_seconds !== undefined
      ? `in ${Math.round(p.split_max_seconds / 60)}-minute parts`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
