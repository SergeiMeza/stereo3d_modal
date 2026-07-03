import type { Step } from "@/lib/api/types";

/**
 * Copy for the paid pipeline steps — one source of truth for the step pages
 * (workspace tabs), tooltips, and tests. Purely presentational; pricing and
 * behavior stay server-side.
 */
export interface StepDef {
  step: Step;
  title: string;
  description: string;
  /** "What you get" bullets on the step page. */
  outputs: string[];
  /** Practical guidance shown in the Tips card. */
  tips: string[];
}

export const STEP_DEFS: readonly StepDef[] = [
  {
    step: "depth_preview",
    title: "Depth",
    description:
      "Define the depth map: pick the depth-map resolution (the cost/quality knob) and a preview frame rate.",
    outputs: [
      "Browser-playable depth video (depth_vis) compared side-by-side against the source",
      "Depth artifact registered for reuse — production inherits this resolution, and its quote discounts the whole depth stage when fps + resolution match",
    ],
    tips: [
      "Resolution is the knob that matters: run depth ONCE at the resolution you want production to use and the depth cost is paid once.",
      "Higher resolutions route to bigger GPUs automatically — pick by the detail you need, capped at the source resolution.",
      "Half the source frame rate is plenty to judge depth; but reuse keys on fps, so a production run at a different rate re-runs depth.",
      "Look for stable depth across a scene — flicker between frames shows up as shimmer in 3D.",
    ],
  },
  {
    step: "stereo_preview",
    title: "Stereo",
    description:
      "Per-scene 3D: every scene is measured and classified automatically; review each scene against the real video, adjust the ones that need it, and preview what you deliver.",
    outputs: [
      "Stereo preview in the SAME presets and formats Deliver sells — SBS, half-SBS, anaglyph, MV-HEVC",
      "The per-scene profile computed by the run seeds this page's Auto defaults",
    ],
    tips: [
      "Every scene defaults to Auto: the profiler measures how far the action is from the camera and picks one of four shot types — only rows you change are sent as overrides.",
      "Close-up — the subject is near the camera. Depth is kept gentle and the subject pops slightly toward you.",
      "Standard — a mid-distance shot. Balanced depth around the screen plane; the most common case.",
      "Wide — an establishing or far shot. Depth sits behind the screen like a window, which keeps edges clean on shots that are hardest to fill.",
      "Dynamic — the camera or subject distance changes during the scene (push-ins, walk-aways), so the 3D strength adapts across the shot instead of staying fixed.",
      "Override a scene's shot type when the automatic pick reads wrong — e.g. force Close-up on a tight shot the profiler called Standard to make it pop more.",
      "Overall 3D strength scales EVERY scene at once; a per-scene shot-type override wins for its scene.",
      "Edges are always finished at full quality: the thin gaps that open along object edges in 3D are filled automatically, so the preview looks exactly like the deliverable.",
      "Uncheck “3D” on a scene to ship it as 2D — both eyes identical, no depth (end credits, logos, title cards).",
      "“Profile shots (free)” measures each scene's depth from the preview proxy and seeds the per-scene controls — no charge, about a minute.",
      "Your tweaks persist per project and carry to the Deliver page automatically.",
    ],
  },
  {
    step: "production",
    title: "Deliver",
    description:
      "Full-quality conversion — inherits your Depth-page resolution and Stereo-page scene tweaks, reusing compatible artifacts at a discount.",
    outputs: [
      "Final outputs in every selected format (MV-HEVC for Vision Pro / spatial players, SBS for TVs and headsets, anaglyph for quick checks)",
      "Full frame rate, full resolution, full-quality edge fill",
    ],
    tips: [
      "The summary chips show exactly what production inherits from the Depth and Stereo pages — each has a “use pipeline default” escape.",
      "Reuse is the default: compatible preview artifacts (depth, preprocess) are discounted automatically — the quote shows each reused stage.",
      "Pick “Start from scratch” to recompute everything, e.g. to raise quality beyond what previews ran at.",
      "Your free Analyze credit is applied to the project's first paid conversion.",
    ],
  },
];

export function stepDef(step: Step): StepDef {
  const def = STEP_DEFS.find((d) => d.step === step);
  if (!def) throw new Error(`unknown step ${step}`);
  return def;
}
