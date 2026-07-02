/**
 * Scene-cut list interchange (Cut page import/export).
 *
 * The pipeline itself runs PySceneDetect, so its scene-list CSV is the
 * natural interchange format: one row per scene, scenes derived from the
 * cut list tiling [0, numFrames) half-open (frame doctrine — integer
 * SOURCE-frame indices everywhere). Timecode columns are display-only,
 * produced by the frames.ts helpers; ONLY the Start Frame column is read
 * back on import — timecodes are never parsed into frames.
 *
 * Import also accepts a bare list of frame indices (one per line, or
 * comma/space separated; #-comments ignored) for hand-made lists. All
 * validation errors throw with a human-readable message.
 */

import { cutsToRanges, frameToTimecode, type RationalFPS } from "./frames";

export const CUTLIST_CSV_HEADER =
  "Scene Number,Start Frame,Start Timecode,End Frame,End Timecode,Length (frames)";

/** PySceneDetect-compatible scene-list CSV for a cut list. Scenes tile
 * [0, numFrames) half-open, so scene 1 always starts at frame 0 and the
 * last scene ends at numFrames (exclusive). */
export function exportCutsCSV(
  cuts: number[],
  numFrames: number,
  fps: RationalFPS,
): string {
  const rows = cutsToRanges(cuts, numFrames).map(([start, end], i) =>
    [
      i + 1,
      start,
      frameToTimecode(start, fps),
      end,
      frameToTimecode(end, fps),
      end - start,
    ].join(","),
  );
  return [CUTLIST_CSV_HEADER, ...rows].join("\n") + "\n";
}

function parseIntStrict(token: string): number {
  if (!/^\d+$/.test(token)) {
    throw new Error(
      `"${token}" is not an integer frame index — cut lists carry whole source-frame numbers only.`,
    );
  }
  return Number(token);
}

/** Validate + normalize raw frame values into a cut list: sorted, deduped,
 * every cut strictly inside (0, numFrames). Throws on violations. */
function normalizeCuts(frames: number[], numFrames: number): number[] {
  const cuts = [...new Set(frames)].sort((a, b) => a - b);
  for (const c of cuts) {
    if (c <= 0 || c >= numFrames) {
      throw new Error(
        `Cut at frame ${c} is out of range — cuts must be inside (0, ${numFrames}) for this video.`,
      );
    }
  }
  return cuts;
}

/** Parse a cut list from (a) the scene-list CSV above (Start Frame column,
 * skipping scene 1's frame 0) or (b) a plain list of frame indices (one per
 * line or comma/space separated; blank lines and #-comments ignored).
 * Returns the sorted, deduped cut list; throws Error (human message) on
 * non-integers or out-of-range frames. */
export function parseCutList(text: string, numFrames: number): number[] {
  const lines = text.split(/\r\n|\r|\n/);
  const headerIndex = lines.findIndex((l) =>
    l.toLowerCase().includes("start frame"),
  );

  if (headerIndex !== -1) {
    // CSV mode: read the Start Frame column by header position.
    const header = lines[headerIndex].split(",").map((c) => c.trim().toLowerCase());
    const col = header.indexOf("start frame");
    const starts: number[] = [];
    for (const line of lines.slice(headerIndex + 1)) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const cells = line.split(",");
      const cell = (cells[col] ?? "").trim();
      if (cell === "") {
        throw new Error(
          `A CSV row is missing its Start Frame value: "${line.trim()}"`,
        );
      }
      starts.push(parseIntStrict(cell));
    }
    if (starts.length === 0) {
      throw new Error("No scenes found in the CSV — nothing to import.");
    }
    // scene 1 starts at frame 0 by definition — it is not a cut
    return normalizeCuts(starts.filter((f) => f !== 0), numFrames);
  }

  // Plain list mode: integers separated by newlines, commas, or spaces.
  const tokens = lines
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .flatMap((l) => l.split(/[\s,]+/))
    .filter((t) => t !== "");
  if (tokens.length === 0) {
    throw new Error("No cut frames found in the file — nothing to import.");
  }
  return normalizeCuts(tokens.map(parseIntStrict), numFrames);
}
