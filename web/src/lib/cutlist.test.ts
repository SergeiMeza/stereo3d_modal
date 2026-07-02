/**
 * Cut-list interchange tests: PySceneDetect-style CSV export shape (scenes
 * tiling [0, numFrames) half-open, timecodes via the frames.ts helpers),
 * import from both accepted shapes, the export→import round-trip, and
 * every rejection rule (non-integers, out-of-range, doctrine violations).
 */

import { describe, expect, it } from "vitest";

import { CUTLIST_CSV_HEADER, exportCutsCSV, parseCutList } from "./cutlist";
import { frameToTimecode, parseRational } from "./frames";

const FPS24 = parseRational("24/1");
const NTSC = parseRational("24000/1001");

describe("exportCutsCSV", () => {
  it("writes the scene-list header and one row per scene, tiling [0, numFrames) half-open", () => {
    const csv = exportCutsCSV([48, 100], 240, FPS24);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(CUTLIST_CSV_HEADER);
    expect(lines).toHaveLength(4); // header + 3 scenes for 2 cuts
    expect(lines[1]).toBe(`1,0,${frameToTimecode(0, FPS24)},48,${frameToTimecode(48, FPS24)},48`);
    expect(lines[2]).toBe(`2,48,${frameToTimecode(48, FPS24)},100,${frameToTimecode(100, FPS24)},52`);
    expect(lines[3]).toBe(`3,100,${frameToTimecode(100, FPS24)},240,${frameToTimecode(240, FPS24)},140`);
  });

  it("handles an empty cut list as a single scene spanning the whole video", () => {
    const lines = exportCutsCSV([], 100, FPS24).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith("1,0,")).toBe(true);
    expect(lines[1].endsWith(",100")).toBe(true);
  });

  it("derives timecodes from the exact rational (NTSC), display-only", () => {
    const csv = exportCutsCSV([1234], 3587, NTSC);
    expect(csv).toContain(`2,1234,${frameToTimecode(1234, NTSC)},3587`);
  });
});

describe("parseCutList — CSV shape", () => {
  it("round-trips exportCutsCSV exactly (Start Frame column, scene 1's frame 0 skipped)", () => {
    const cuts = [266, 314, 350, 3500];
    expect(parseCutList(exportCutsCSV(cuts, 3587, FPS24), 3587)).toEqual(cuts);
  });

  it("reads the Start Frame column by header position, ignoring extra columns and preamble", () => {
    const csv = [
      "Timecode List: 00:00:02:00", // PySceneDetect writes an optional preamble
      "Scene Number,Start Frame,Start Timecode,Start Time (seconds),End Frame,End Timecode,End Time (seconds),Length (frames)",
      "1,0,00:00:00:00,0.0,48,00:00:02:00,2.0,48",
      "2,48,00:00:02:00,2.0,240,00:00:10:00,10.0,192",
    ].join("\n");
    expect(parseCutList(csv, 240)).toEqual([48]);
  });

  it("rejects CSV rows whose Start Frame is missing or not an integer", () => {
    const bad = [CUTLIST_CSV_HEADER, "1,abc,00:00:00:00,48,00:00:02:00,48"].join("\n");
    expect(() => parseCutList(bad, 240)).toThrow(/not an integer/);
    const missing = [CUTLIST_CSV_HEADER, "1"].join("\n");
    expect(() => parseCutList(missing, 240)).toThrow(/missing its Start Frame/);
  });

  it("rejects a CSV with no scene rows", () => {
    expect(() => parseCutList(CUTLIST_CSV_HEADER, 240)).toThrow(/No scenes found/);
  });
});

describe("parseCutList — plain lists", () => {
  it("accepts one integer per line, ignoring blanks and #comments", () => {
    expect(parseCutList("# my cuts\n48\n\n100\n# tail\n200\n", 240)).toEqual([
      48, 100, 200,
    ]);
  });

  it("accepts comma/space separated values and sorts + dedupes", () => {
    expect(parseCutList("100, 48 200\n48", 240)).toEqual([48, 100, 200]);
  });

  it("rejects non-integers (floats, garbage) with a human message", () => {
    expect(() => parseCutList("48.5", 240)).toThrow(/"48\.5" is not an integer/);
    expect(() => parseCutList("frame 12", 240)).toThrow(/not an integer/);
    expect(() => parseCutList("-3", 240)).toThrow(/not an integer/);
  });

  it("rejects frames outside (0, numFrames) — 0, numFrames, and beyond", () => {
    expect(() => parseCutList("0\n48", 240)).toThrow(/frame 0 is out of range/);
    expect(() => parseCutList("240", 240)).toThrow(/frame 240 is out of range/);
    expect(() => parseCutList("48\n999", 240)).toThrow(/frame 999 is out of range/);
  });

  it("rejects an empty / comment-only file", () => {
    expect(() => parseCutList("", 240)).toThrow(/No cut frames found/);
    expect(() => parseCutList("# nothing\n\n", 240)).toThrow(/No cut frames found/);
  });
});
