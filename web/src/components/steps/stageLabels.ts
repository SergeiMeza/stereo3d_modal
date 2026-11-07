/**
 * User-facing labels for pipeline stage strings. Modal reports INTERNAL
 * stage names, often with a worker detail in brackets — "video_stereo[propainter]",
 * "video_depth[2814:3587]" — and model names / internal terms must never
 * reach the UI. Every rendered stage goes through stageLabel(): known
 * bases map to product copy; unknown ones fall back to the base name with
 * the bracket suffix STRIPPED (so even a brand-new stage can only leak a
 * snake_case stage name, never its worker/model detail) and underscores
 * spaced.
 */
import { EN, type Tr } from "@/lib/i18n/t";

/** Known stage bases, each with its message (runs.stages.<base>). */
const STAGE_KEYS = new Set([
  // shared video pipeline (app/pipelines/video.py)
  "preprocess",
  "profile_scenes",
  "video_depth",
  "video_stereo",
  "encode_outputs",
  "encode_mvhevc",
  "image_stereo",
  // Lifelike pipeline (queued → plan → render → encode → publish → done)
  "queued",
  "plan",
  "render",
  "encode",
  "publish",
  "done",
  // analyze job stages (also mapped in AnalyzeBadge for its own display)
  "analyze",
  "proxy",
  "scene_detect",
  "thumbnails",
]);

/** Product copy for a raw pipeline stage string. */
export function stageLabel(stage: string, t: Tr = EN): string {
  const base = stage.split("[")[0].trim();
  return STAGE_KEYS.has(base) ? t(`runs.stages.${base}`) : base.replace(/_/g, " ");
}
