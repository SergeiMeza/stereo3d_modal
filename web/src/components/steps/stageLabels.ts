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
const STAGE_LABELS: Record<string, string> = {
  // shared video pipeline (app/pipelines/video.py)
  preprocess: "Preparing the video",
  profile_scenes: "Profiling scenes",
  video_depth: "Computing the depth map",
  video_stereo: "Building the 3D video",
  encode_outputs: "Encoding outputs",
  encode_mvhevc: "Encoding MV-HEVC",
  image_stereo: "Building the 3D image",
  // Lifelike pipeline (queued → plan → render → encode → publish → done)
  queued: "Waiting to start",
  plan: "Preparing",
  render: "Rendering in 3D",
  encode: "Encoding",
  publish: "Publishing",
  done: "Finishing up",
  // analyze job stages (also mapped in AnalyzeBadge for its own display)
  analyze: "Analyzing",
  proxy: "Building the preview",
  scene_detect: "Detecting scenes",
  thumbnails: "Rendering thumbnails",
};

/** Shown instead of the stage while a job waits for a free GPU — that
 * wait is not progress, so the tracker never renders it as a stage. */
export const WAITING_FOR_GPU_LABEL = "Waiting for a free GPU";

/** Product copy for a raw pipeline stage string. */
export function stageLabel(stage: string): string {
  const base = stage.split("[")[0].trim();
  return STAGE_LABELS[base] ?? base.replace(/_/g, " ");
}
