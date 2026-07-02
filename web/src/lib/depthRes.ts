/**
 * Depth-map resolution choices for the Depth page.
 *
 * `depth_res` is the depth model's inference resolution: the model resizes
 * the frame's SHORT side to this value and the long side follows the source
 * aspect (see app/pipelines/video.py — depth_res → input_size). It must be a
 * multiple of 14 (the model's patch size); the gateway rejects anything else,
 * clamped to [140, 2520].
 *
 * Two rails the UI enforces so users never pick an invalid value:
 *   1. depth_res can never exceed the SOURCE short side — you cannot invent
 *      resolution the source doesn't have. We drop over-source presets and
 *      offer a synthetic "source native" choice at the source short side
 *      (rounded DOWN to a multiple of 14) so the max always equals the real
 *      source, whatever its aspect.
 *   2. GPU tier is NOT surfaced here. The backend routes the depth GPU by
 *      WORKING MEGAPIXELS (input_size² × elongation) — aspect- and
 *      orientation-aware — so the old 16:9-only "· L40S/H200" label was
 *      wrong for portrait/square/ultra-wide sources. Cost/quality is the
 *      user's axis; which GPU runs it is the backend's business.
 */

/** The depth model's patch size — every depth_res must be a multiple of it. */
export const DEPTH_RES_STEP = 14;
/** Gateway rails, mirrored so the UI never offers a rejectable value. */
export const DEPTH_RES_MIN = 140;
export const DEPTH_RES_MAX = 2520;

/** depth_res that prices at 1× (gateway depth_res_base) and the app default. */
export const DEFAULT_DEPTH_RES = 980;

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
 * The depth-res choices offered for a given source, ascending. Presets above
 * the source short side are dropped; a "source native" choice at the source
 * short side (floored to ×14) is added so the maximum always equals the real
 * source, whatever the aspect. De-duplicated when a preset already lands on
 * the source-native value.
 */
export function depthResChoices(
  sourceShortSide: number,
): DepthResChoice[] {
  const native = floorToStep(sourceShortSide);
  const kept = PRESET_CHOICES.filter((c) => c.value <= native);
  // Add the source-native choice unless a preset already sits exactly there.
  if (!kept.some((c) => c.value === native)) {
    kept.push({ value: native, name: "source native" });
  } else {
    // Mark the preset that lands on the source ceiling so the label reads
    // "… — source native" (it IS the source's native short side).
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
