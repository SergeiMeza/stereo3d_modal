/**
 * One name for each thing (S3D-37). Every page, the Files list, History,
 * the landing page and tests read customer-facing names for formats,
 * qualities, methods, steps and edge modes from here — never the wire
 * values ("mvhevc", "qhd", "propainter").
 */

import type {
  Format,
  Inpaint,
  Method,
  Params,
  Preset,
  Probe,
  QualityOption,
  Step,
  Warp,
} from "@/lib/api/types";
import { formatVideoLength } from "@/lib/format";

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
  "5k": "5K",
  "6k": "6K",
  "8k": "8K",
};

/** Output short side per eye of each quality. */
export const QUALITY_SHORT_SIDE: Record<Preset, number> = {
  draft: 1080,
  "1080p": 1080,
  qhd: 1440,
  "3k": 1620,
  "4k": 2160,
  "5k": 2880,
  "6k": 3240,
  "8k": 4320,
};

/** Qualities a page offers on its own (no Draft), in order. Lifelike's
 * 5K/6K/8K come only from the gateway's list (S3D-48). */
export const QUALITIES: readonly Preset[] = ["1080p", "qhd", "3k", "4k"];

export function qualityName(p: string | undefined): string {
  if (p === undefined) return "";
  return QUALITY_NAMES[p as Preset] ?? p;
}

/** Classic stops at 3K (S3D-12); 4K and above are Lifelike only. */
export const CLASSIC_QUALITIES: readonly Preset[] = ["1080p", "qhd", "3k"];

/** Qualities a source can have (S3D-04): at or below its short side; a
 * source below 1080 still gets 1080p. Classic stops at 3K. */
export function qualitiesFor(
  probe: { width: number; height: number } | undefined,
  method: "lifelike" | "classic" = "lifelike",
): Preset[] {
  const short = probe ? Math.min(probe.width, probe.height) : Infinity;
  const list = method === "classic" ? CLASSIC_QUALITIES : QUALITIES;
  return list.filter((p) => p === "1080p" || QUALITY_SHORT_SIDE[p] <= short);
}

/** Per-eye output size of a step for a source, keeping its shape (even
 * pixels, never above the source). */
export function eyeSize(
  probe: { width: number; height: number },
  shortSide: number,
): { width: number; height: number } {
  const srcShort = Math.min(probe.width, probe.height);
  const k = Math.min(1, shortSide / srcShort);
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { width: even(probe.width), height: even(probe.height) };
}

/** A quality option with its per-eye size hint. Copy rule (S3D-04): name
 * only the size ("4K · 3840×2160 per eye") — never "more detail" or
 * "sharper" between steps, nothing above 4K. */
export interface QualityChoice {
  preset: Preset;
  label: string;
  /** "3840×1606 per eye" */
  hint?: string;
  /** output short side per eye, when known */
  eyeShort?: number;
  /** S3D-65: one eye must keep the original picture at this size */
  originalEyeRequired?: boolean;
}

/** The option text: "4K · 3840×2160 per eye". */
export function qualityChoiceText(q: QualityChoice): string {
  return q.hint ? `${q.label} · ${q.hint}` : q.label;
}

/** Lifelike's quality options for a project (S3D-04): the gateway's list
 * when it sends one; otherwise the steps the source reaches, with a source
 * below 1080 offered as "Full resolution (720p)" at the 1080p price. */
export function qualityChoices(project: {
  qualities?: QualityOption[];
  probe?: Probe;
}): QualityChoice[] {
  const hint = (w?: number, h?: number) =>
    w && h ? `${w}×${h} per eye` : undefined;
  if (project.qualities && project.qualities.length > 0) {
    return project.qualities.map((q) => ({
      preset: q.preset,
      label: q.label,
      hint: hint(q.eye_width, q.eye_height),
      eyeShort:
        q.eye_width && q.eye_height
          ? Math.min(q.eye_width, q.eye_height)
          : QUALITY_SHORT_SIDE[q.preset],
      ...(q.original_eye_required ? { originalEyeRequired: true } : {}),
    }));
  }
  const probe = project.probe;
  return qualitiesFor(probe).map((p) => {
    if (!probe) return { preset: p, label: qualityName(p) };
    const size = eyeSize(probe, QUALITY_SHORT_SIDE[p]);
    const short = Math.min(size.width, size.height);
    return {
      preset: p,
      label:
        short < QUALITY_SHORT_SIDE[p]
          ? `Full resolution (${short}p)`
          : qualityName(p),
      hint: hint(size.width, size.height),
      eyeShort: short,
    };
  });
}

/** The name of a quality a project's run used (labels from its options). */
export function qualityLabelFor(
  project: { qualities?: QualityOption[]; probe?: Probe },
  preset: string | undefined,
): string {
  const c = qualityChoices(project).find((q) => q.preset === preset);
  return c?.label ?? qualityName(preset);
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

/** Classic edge style (S3D-29): two equal options, Stretched then Filled
 * (Filled preselected) — a matter of taste, never ranked. The old per-frame fill
 * is no longer offered; old runs that used it keep a name. */
export type EdgeMode = "filled" | "stretched";

/** Option labels on the pages. */
export const EDGE_STYLE_NAMES: Record<EdgeMode, string> = {
  filled: "Filled",
  stretched: "Stretched",
};

/** Names in run summaries (History, Files). */
export const EDGE_NAMES: Record<EdgeMode | "fast" | "none", string> = {
  filled: "Filled edges",
  stretched: "Stretched edges",
  fast: "Fast fill (no longer offered)",
  none: "Unfilled edges",
};

/** The edge mode a run's (inpaint, warp) pair stands for. */
export function edgeModeOf(p: {
  inpaint?: Inpaint;
  warp?: Warp;
}): EdgeMode | "fast" | "none" | null {
  if (p.warp === "backward") return "stretched";
  if (p.inpaint === "propainter") return "filled";
  if (p.inpaint === "migan") return "fast";
  if (p.inpaint === "none") return "none";
  return null;
}

/** A run's settings in words: "4K · Vision Pro spatial video + Side by
 * side · Filled edges". Classic knobs only when the run carried them. */
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
    p.original_eye
      ? `Original picture in the ${p.original_eye} eye`
      : null,
    p.foveation === "static" ? "Foveated Detail" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A video's resolution in customer words: "4K", "1080p", "720p". */
export function resolutionName(probe: { width: number; height: number }): string {
  const short = Math.min(probe.width, probe.height);
  if (short >= 2160) return "4K";
  if (short >= 1620) return "3K";
  if (short >= 1440) return "1440p";
  return `${short}p`;
}

/** "5 min 12 s · 4K · 30 fps · 14 scenes" — a video at a glance, with no
 * frame counts or rational frame rates (S3D-36). */
export function videoFacts(project: {
  probe?: Probe;
  scenes?: { cuts: number[] | null };
}): string {
  const p = project.probe;
  if (!p) return "";
  const fps = Math.round(p.fps * 100) / 100;
  const scenes = (project.scenes?.cuts ?? []).length + 1;
  return [
    formatVideoLength(p.duration_s),
    resolutionName(p),
    `${fps} fps`,
    project.scenes ? `${scenes} scene${scenes === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
