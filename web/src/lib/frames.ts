/**
 * Frame doctrine display helpers (web/DESIGN.md).
 *
 * Every edit decision in the app is an integer SOURCE-frame index. This
 * module is the ONLY place frames are converted for display — components
 * never do fps math themselves. All conversions use the exact rational fps
 * ("24000/1001"); the float `fps` field is never used for math.
 *
 * Timecode is display-layer only. Non-drop-frame notation everywhere
 * (HH:MM:SS:FF counts frames, it does not measure wall-clock for NTSC
 * rates — fine for an editing UI where frame identity is what matters).
 */

export interface RationalFPS {
  num: number;
  den: number;
}

/** Parse "24000/1001" | "24/1" | "24". Throws on garbage — a bad rational
 * must fail loudly, not silently mis-map frames. */
export function parseRational(fpsRational: string): RationalFPS {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(fpsRational.trim());
  if (!m) throw new Error(`invalid fps_rational: ${JSON.stringify(fpsRational)}`);
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (num <= 0 || den <= 0) {
    throw new Error(`invalid fps_rational: ${JSON.stringify(fpsRational)}`);
  }
  return { num, den };
}

/** Exact seconds a frame index starts at: frame * den / num. */
export function frameToSeconds(frame: number, fps: RationalFPS): number {
  return (frame * fps.den) / fps.num;
}

/** The frame whose interval contains time t (floor — never rounds up into
 * a frame that hasn't started; the class of bug that motivated the frame
 * doctrine). */
export function secondsToFrame(seconds: number, fps: RationalFPS): number {
  // guard float fuzz: 2.9999999996s at 24fps is frame 72, not 71
  return Math.floor((seconds * fps.num) / fps.den + 1e-9);
}

/** The frame whose PRESENTATION TIMESTAMP this is. Unlike secondsToFrame
 * (floor — correct for arbitrary times inside a frame's interval), a
 * presentation timestamp names a frame START, so round-to-nearest is the
 * correct inverse and tolerates the browser's timestamp quantization:
 * Chromium reports requestVideoFrameCallback mediaTime in integer
 * MICROSECONDS, so a 24fps frame at 245/24s comes back as 10.208333 —
 * 0.33µs low — and floor would name the previous frame (observed: the
 * frame stepper stuck on every frame whose PTS rounds down). */
export function presentationTimeToFrame(
  mediaTime: number,
  fps: RationalFPS,
): number {
  return Math.round((mediaTime * fps.num) / fps.den);
}

/** Frames-per-second rounded UP to the integer frame count of a timecode
 * second (e.g. 23.976 → 24 frames labeled per second). */
function framesPerTimecodeSecond(fps: RationalFPS): number {
  return Math.ceil(fps.num / fps.den - 1e-9);
}

/** Non-drop-frame timecode HH:MM:SS:FF for a frame index. */
export function frameToTimecode(frame: number, fps: RationalFPS): string {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`frame must be a non-negative integer, got ${frame}`);
  }
  const fptc = framesPerTimecodeSecond(fps);
  const ff = frame % fptc;
  const totalSeconds = Math.floor(frame / fptc);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** Inverse of frameToTimecode (non-drop). */
export function timecodeToFrame(tc: string, fps: RationalFPS): number {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{1,2})$/.exec(tc.trim());
  if (!m) throw new Error(`invalid timecode: ${JSON.stringify(tc)}`);
  const [hh, mm, ss, ff] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const fptc = framesPerTimecodeSecond(fps);
  if (ff >= fptc || mm >= 60 || ss >= 60) {
    throw new Error(`timecode out of range for ${fps.num}/${fps.den}: ${tc}`);
  }
  return ((hh * 3600 + mm * 60 + ss) * fptc) + ff;
}

/** "1:23.5s · frame 2004" style label for compact UI readouts. */
export function frameLabel(frame: number, fps: RationalFPS): string {
  return `${frameToTimecode(frame, fps)} · f${frame}`;
}

/** Map a horizontal position (0..1) on a filmstrip of `numFrames` to the
 * frame under the cursor. Clamped; half-open (never returns numFrames). */
export function positionToFrame(pos: number, numFrames: number): number {
  if (numFrames <= 0) return 0;
  const clamped = Math.min(Math.max(pos, 0), 1);
  // guard float fuzz (same as secondsToFrame): frameToPosition(f)*numFrames
  // can land at f - 1e-13, which must floor to f, not f-1 — otherwise the
  // position↔frame round-trip loses frames (e.g. 461 of 3587).
  return Math.min(Math.floor(clamped * numFrames + 1e-9), numFrames - 1);
}

/** Fraction (0..1) of the filmstrip where a frame's marker sits. */
export function frameToPosition(frame: number, numFrames: number): number {
  if (numFrames <= 0) return 0;
  return Math.min(Math.max(frame / numFrames, 0), 1);
}

/** Validate a cut list the way the gateway will (strictly increasing,
 * each in (0, numFrames)) so the UI rejects bad edits before the network. */
export function validateCuts(cuts: number[], numFrames: number): string | null {
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    if (!Number.isInteger(c)) return `cut ${c} is not an integer frame`;
    if (c <= 0 || c >= numFrames) return `cut ${c} outside (0, ${numFrames})`;
    if (i > 0 && c <= cuts[i - 1]) return `cuts not strictly increasing at ${c}`;
  }
  return null;
}

/** A selectable target-fps choice. Only exact DIVISORS of the source rate
 * are offered: the pipeline decimates those by pixel-perfect frame select
 * (every Nth frame), while arbitrary rates fall back to nearest-frame
 * resampling. Target fps can never exceed the source rate — you cannot
 * invent frames. */
export interface FPSOption {
  /** value to send as target_fps (2-decimal float; the pipeline snaps
   * anything within 4% of a divisor to the exact divisor) */
  value: number;
  /** professional label: rate shown to 2 decimals when fractional
   * ("23.98"), with the decimation noted ("11.99 · ½ rate") */
  label: string;
  divisor: number;
}

function fmtRate(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

const FRACTION_LABELS: Record<number, string> = {
  2: "½",
  3: "⅓",
  4: "¼",
  6: "⅙",
  8: "⅛",
  12: "1⁄12",
};

/** Target-fps choices for a source rate, full rate first. */
export function fpsOptions(fps: RationalFPS): FPSOption[] {
  const full = fps.num / fps.den;
  return [1, 2, 3, 4, 6, 8, 12]
    .filter((n) => full / n >= 1)
    .map((n) => ({
      divisor: n,
      value: Math.round((full / n) * 100) / 100,
      label:
        n === 1
          ? `${fmtRate(full)} (full)`
          : `${fmtRate(full / n)} (${FRACTION_LABELS[n]} rate)`,
    }));
}

/** Default preview rate: the source's full rate (divisor 1). */
export function defaultPreviewFPS(fps: RationalFPS): FPSOption {
  const options = fpsOptions(fps);
  return options.find((o) => o.divisor === 1) ?? options[0];
}

/** Scene ranges [(start, end), …] implied by a cut list — half-open,
 * tiling [0, numFrames) exactly like the pipeline does. */
export function cutsToRanges(
  cuts: number[],
  numFrames: number,
): Array<[number, number]> {
  const edges = [0, ...cuts, numFrames];
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < edges.length; i++) out.push([edges[i], edges[i + 1]]);
  return out;
}
