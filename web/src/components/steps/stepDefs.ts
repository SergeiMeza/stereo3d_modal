import type { Method, Step } from "@/lib/api/types";

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
      "Check how far away everything is before you make 3D: pick the depth detail and see a depth video beside your source. Optional.",
    outputs: [
      "A depth video you can play beside your source, near is bright and far is dark",
      "Make 3D reuses this depth work, and discounts it, when the depth detail, frame rate, scene cuts and 2D scenes all still match",
    ],
    tips: [
      "Depth detail is the setting that matters: run it at the detail you want for the final video, so Make 3D can reuse the work at a discount.",
      "Changing scene cuts or which scenes stay 2D means the next run can't reuse this depth work.",
      "Higher detail costs more; it is capped at your video's own resolution.",
      "Look for stable depth across a scene — flicker between frames shows up as shimmer in 3D.",
    ],
  },
  {
    step: "stereo_preview",
    title: "3D look",
    description:
      "Per-scene 3D: every scene is measured and classified automatically; review each scene against the real video, adjust the ones that need it, and preview what you deliver.",
    outputs: [
      "A 3D preview in the same qualities and formats Make 3D offers",
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
      "Best edges is the default: the thin gaps that open along object edges in 3D are filled for the cleanest result. Faster, cheaper edge modes are under Advanced.",
      "Uncheck “3D” on a scene to ship it as 2D — both eyes identical, no depth (end credits, logos, title cards).",
      "“Profile shots (free)” measures each scene's depth from the preview proxy and seeds the per-scene controls — no charge, about a minute.",
      "Your tweaks persist per project and carry to Make 3D automatically.",
    ],
  },
  {
    step: "production",
    title: "Make 3D",
    description:
      "The whole video (or the part you pick) in 3D. It uses your Depth and 3D look settings and reuses earlier depth work at a discount.",
    outputs: [
      "Your video in every format you pick: Vision Pro spatial video, side by side for other headsets and 3D TVs, red-cyan for a quick check",
      "Full frame rate at the quality you pick, with Best edges unless you chose otherwise under Advanced",
    ],
    tips: [
      "The summary shows which Depth and 3D look settings this run uses — each can be switched back to automatic.",
      "Reuse is the default: compatible preview artifacts (depth, preprocess) are discounted automatically — the quote shows each reused stage.",
      "Pick “Start from scratch” to recompute everything, e.g. to raise quality beyond what previews ran at.",
    ],
  },
];

/** Lifelike pages: Preview and Deliver. Customer copy only — never how
 * the method works inside. */
export const LIFELIKE_STEP_DEFS: readonly StepDef[] = [
  {
    step: "lifelike_preview",
    title: "Preview",
    description:
      "Pick a moment on the timeline and see about 5 seconds of it in 3D, in the quality you choose, before you deliver the whole video.",
    outputs: [
      "About 5 seconds of your video in 3D, starting at the moment you pick",
      "Side by side, so you can play it right here or on a headset",
    ],
    tips: [
      "Pick a moment with the kind of shot that matters most to you — faces, fast motion, or wide views.",
      "A preview is a small charge — you see the exact price before it runs.",
      "Happy with it? Make 3D renders the whole video the same way.",
    ],
  },
  {
    step: "production",
    title: "Make 3D",
    description:
      "The whole video in 3D, in the quality and formats you pick.",
    outputs: [
      "Vision Pro spatial video, full side by side, and half side by side",
      "Long videos can come as 15-minute parts that each play smoothly",
    ],
    tips: [
      "Vision Pro spatial video is for Apple Vision Pro; side by side plays on most other headsets and 3D TVs.",
      "Half side by side keeps the file small; full side by side keeps every pixel.",
      "Runs over $25 are charged when they start and refunded in full if they fail; smaller runs go on your balance after they succeed.",
    ],
  },
];

export function stepDef(step: Step, method: Method = "classic"): StepDef {
  const defs = method === "lifelike" ? LIFELIKE_STEP_DEFS : STEP_DEFS;
  const def = defs.find((d) => d.step === step);
  if (!def) throw new Error(`unknown step ${step}`);
  return def;
}
