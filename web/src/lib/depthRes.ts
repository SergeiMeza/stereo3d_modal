/**
 * Depth-map resolution choices for the Depth page.
 *
 * `depth_res` is the depth model's inference resolution: the model resizes
 * the frame's SHORT side to this value and the long side follows the source
 * aspect (see app/pipelines/video.py — depth_res → input_size). It must be a
 * multiple of 14 (the model's patch size); the gateway rejects anything else,
 * clamped to [140, 2520].
 *
 * Three rails the UI enforces so users never pick an invalid value:
 *   1. depth_res can never exceed the SOURCE short side — you cannot invent
 *      resolution the source doesn't have. We drop over-source presets and
 *      offer a synthetic "source native" choice at the source short side
 *      (rounded DOWN to a multiple of 14) so the max always equals the real
 *      source, whatever its aspect.
 *   2. depth_res can never exceed the WORKING-MEGAPIXEL VRAM ceiling. The
 *      backend routes the depth GPU by WORKING MEGAPIXELS
 *      (input_size² × elongation, elongation = long/short ≥ 1) and hard-fails
 *      above the top tier's ceiling (B200 ~8.5 MP — see _route_depth_gpu in
 *      app/pipelines/video.py). That ceiling is aspect-dependent: a wide
 *      2.39:1 source hits it at a far lower depth_res than 16:9, so a flat
 *      "≤ source short side" cap alone let ultra-wide 4K sources offer values
 *      (e.g. 2156) that Modal rejects mid-job. We cap the offered max at
 *      min(source short side, aspect ceiling) so every choice is runnable.
 *   3. GPU tier is NOT surfaced here. Which of L40S/H200/B200 runs a runnable
 *      job is the backend's business — cost/quality is the user's axis. (Only
 *      the top-tier CEILING leaks up, as rail 2, because past it there is no
 *      GPU at all and the job cannot run.)
 */

/** The depth model's patch size — every depth_res must be a multiple of it. */
export const DEPTH_RES_STEP = 14;
/** Gateway rails, mirrored so the UI never offers a rejectable value. */
export const DEPTH_RES_MIN = 140;
export const DEPTH_RES_MAX = 2520;

/** depth_res that prices at 1× (gateway depth_res_base) and the app default. */
export const DEFAULT_DEPTH_RES = 980;

/**
 * Working-megapixel VRAM ceiling of the top depth GPU tier (B200), mirrored
 * from app/pipelines/video.py `B200_MAX_MP`. The depth model resizes the SHORT
 * side to depth_res and the long side follows the source aspect, so
 * working_mp = depth_res² × elongation / 1e6 (elongation = long/short ≥ 1).
 * Above this there is no GPU tier and Modal rejects the job — keep in lockstep
 * with the gateway `depthB200MaxMP` and Modal `B200_MAX_MP` if the tier changes.
 */
export const DEPTH_MAX_WORK_MP = 8.5;

/**
 * Largest depth_res (multiple of 14, within the gateway rails) whose working
 * megapixels fit the B200 ceiling for a source of the given dimensions.
 * Aspect-aware: a wide source's long side inflates working MP, so its max
 * depth_res is lower than a near-square source's. Orientation-agnostic —
 * only the elongation (long/short) matters.
 */
export function maxDepthResForAspect(width: number, height: number): number {
  const long = Math.max(width, height);
  const short = Math.max(Math.min(width, height), 1);
  const elongation = long / short; // ≥ 1
  return floorToStep(Math.sqrt((DEPTH_MAX_WORK_MP * 1e6) / elongation));
}

export interface DepthResChoice {
  value: number;
  /** Optional quality name ("Standard"); "source native" for the synthetic
   * source-short-side choice. */
  name?: string;
}

/** Sold depth resolutions — all multiples of 14, cost/quality only. */
const PRESET_CHOICES: readonly DepthResChoice[] = [
  { value: 518, name: "Draft" },
  { value: 700 },
  { value: 980, name: "Standard" },
  { value: 1148, name: "High" },
  { value: 1442, name: "Very high" },
  { value: 2100 },
  { value: 2520, name: "Maximum" },
];

/** Largest multiple of 14 that is ≤ n and inside the gateway rails. */
function floorToStep(n: number): number {
  return Math.max(DEPTH_RES_MIN, Math.min(DEPTH_RES_MAX, Math.floor(n / DEPTH_RES_STEP) * DEPTH_RES_STEP));
}

/**
 * The depth-res choices offered for a given source, ascending. The offered
 * maximum is min(source short side, B200 working-MP ceiling for this aspect):
 * you cannot exceed the source's own resolution, and you cannot exceed what
 * the top GPU tier can fit (a wide source hits the VRAM ceiling first). Presets
 * above that max are dropped; a synthetic "source native" choice at the max
 * (floored to ×14) is added so the offered ceiling is always a valid, runnable
 * value. De-duplicated when a preset already lands on it.
 *
 * Pass the FULL source dimensions so the aspect ceiling can be computed. The
 * legacy short-side-only signature is preserved by defaulting height to the
 * width (a 1:1 aspect, whose ceiling never binds below the source short side),
 * so callers that only have the short side degrade to the pre-aspect behavior.
 */
export function depthResChoices(
  sourceWidth: number,
  sourceHeight: number = sourceWidth,
): DepthResChoice[] {
  const shortSide = Math.min(sourceWidth, sourceHeight);
  const aspectMax = maxDepthResForAspect(sourceWidth, sourceHeight);
  const native = Math.min(floorToStep(shortSide), aspectMax);
  const kept = PRESET_CHOICES.filter((c) => c.value <= native);
  // Add the source-native choice unless a preset already sits exactly there.
  if (!kept.some((c) => c.value === native)) {
    kept.push({ value: native, name: "source native" });
  } else {
    // Mark the preset that lands on the ceiling so the label reads
    // "… — source native" (it IS the largest runnable value for this source).
    const i = kept.findIndex((c) => c.value === native);
    kept[i] = { value: native, name: "source native" };
  }
  return kept.sort((a, b) => a.value - b.value);
}

/** Clamp a desired depth_res to the largest offered choice ≤ it (else the
 * smallest offered) so a tiny source never leaves the default above the cap. */
export function clampDepthRes(
  desired: number,
  choices: DepthResChoice[],
): number {
  const atOrBelow = choices.filter((c) => c.value <= desired);
  if (atOrBelow.length > 0) return atOrBelow[atOrBelow.length - 1].value;
  return choices[0].value;
}

/** Dropdown label — quality/name only, NO GPU tier (see module comment). */
export function depthResLabel(choice: DepthResChoice): string {
  return choice.name ? `${choice.value} — ${choice.name}` : `${choice.value}`;
}
