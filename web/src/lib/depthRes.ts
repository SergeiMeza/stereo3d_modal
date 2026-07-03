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
 *   3. The backend also FAILS FAST above the largest GPU tier's VRAM ceiling
 *      (B200_MAX_MP in app/pipelines/video.py). Because working MP scales with
 *      the aspect (input_size² × elongation), a WIDE source hits that ceiling
 *      at a depth_res the flat [140, 2520] rail otherwise allows — e.g. a
 *      2.39:1 source can only reach depth_res ~1876, not 2520. We cap the
 *      offered choices by this aspect-aware ceiling so the UI never offers a
 *      value Modal would reject mid-job.
 */

/** The depth model's patch size — every depth_res must be a multiple of it. */
export const DEPTH_RES_STEP = 14;
/** Gateway rails, mirrored so the UI never offers a rejectable value. */
export const DEPTH_RES_MIN = 140;
export const DEPTH_RES_MAX = 2520;

/**
 * Largest GPU tier's VRAM ceiling in working megapixels. Mirrors B200_MAX_MP in
 * app/pipelines/video.py and depthB200MaxMP in the gateway. work_mp =
 * depth_res² × elongation must stay ≤ this or Modal fails fast.
 */
export const DEPTH_MAX_WORK_MP = 8.5;

/**
 * The largest depth_res this source's aspect can use before the depth model's
 * working megapixels (depth_res² × elongation) exceed the GPU VRAM ceiling,
 * floored to a multiple of 14. elongation = long / short ≥ 1, so a wider source
 * yields a lower cap. Returns DEPTH_RES_MAX when dimensions are unknown.
 */
export function maxDepthResForAspect(width: number, height: number): number {
  if (!width || !height) return DEPTH_RES_MAX;
  const long = Math.max(width, height);
  const short = Math.max(Math.min(width, height), 1);
  const elongation = long / short;
  const raw = Math.sqrt((DEPTH_MAX_WORK_MP * 1e6) / elongation);
  return Math.floor(raw / DEPTH_RES_STEP) * DEPTH_RES_STEP;
}

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
 * The depth-res choices offered for a given source, ascending. The ceiling is
 * the MIN of two rails: the source short side (can't invent resolution) and the
 * aspect-aware VRAM cap (wide sources hit the GPU ceiling sooner). Presets above
 * the ceiling are dropped; a synthetic choice at the ceiling (floored to ×14) is
 * added so the max always equals what the backend can actually run. It's named
 * "source native" when the source short side is the binding rail, or "aspect max"
 * when the VRAM ceiling binds first (a wide source below its native resolution).
 */
export function depthResChoices(
  sourceWidth: number,
  sourceHeight: number,
): DepthResChoice[] {
  const shortSide = Math.min(sourceWidth, sourceHeight);
  const sourceCap = floorToStep(shortSide);
  const aspectCap = maxDepthResForAspect(sourceWidth, sourceHeight);
  const ceiling = Math.min(sourceCap, aspectCap);
  // Name the synthetic top choice for whichever rail binds. When the aspect
  // cap is strictly the lower one, the ceiling is a VRAM limit, not the source.
  const topName = aspectCap < sourceCap ? "aspect max" : "source native";

  const kept = PRESET_CHOICES.filter((c) => c.value <= ceiling);
  if (!kept.some((c) => c.value === ceiling)) {
    kept.push({ value: ceiling, name: topName });
  } else {
    const i = kept.findIndex((c) => c.value === ceiling);
    kept[i] = { value: ceiling, name: topName };
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
