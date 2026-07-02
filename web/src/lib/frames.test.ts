import { describe, expect, it } from "vitest";

import {
  cutsToRanges,
  defaultPreviewFPS,
  fpsOptions,
  frameToPosition,
  frameToSeconds,
  frameToTimecode,
  parseRational,
  positionToFrame,
  secondsToFrame,
  timecodeToFrame,
  validateCuts,
} from "./frames";

const NTSC24 = parseRational("24000/1001"); // 23.976…
const EXACT24 = parseRational("24/1");

describe("parseRational", () => {
  it("parses n/d and bare integers", () => {
    expect(parseRational("24000/1001")).toEqual({ num: 24000, den: 1001 });
    expect(parseRational("24/1")).toEqual({ num: 24, den: 1 });
    expect(parseRational("30")).toEqual({ num: 30, den: 1 });
  });
  it("rejects garbage loudly", () => {
    for (const bad of ["", "23.976", "24/0", "0/1", "abc", "-24/1"]) {
      expect(() => parseRational(bad)).toThrow();
    }
  });
});

describe("frame ↔ seconds (exact rational, no float-fps drift)", () => {
  it("round-trips every frame of a minute of NTSC film", () => {
    // THE bug class this module exists to kill: at 23.976 float fps,
    // frame → seconds → frame drifts. With the rational it never does.
    for (let f = 0; f < 60 * 24; f++) {
      expect(secondsToFrame(frameToSeconds(f, NTSC24), NTSC24)).toBe(f);
    }
  });
  it("floors into the containing frame (never rounds up early)", () => {
    // 0.99 × frame duration is still frame 0
    const justBefore = frameToSeconds(1, EXACT24) - 1e-6;
    expect(secondsToFrame(justBefore, EXACT24)).toBe(0);
  });
  it("frame 2878 of the sample video is ~119.9s @ 24fps", () => {
    expect(frameToSeconds(2878, EXACT24)).toBeCloseTo(119.9167, 3);
  });
});

describe("timecode (non-drop)", () => {
  it("formats and parses at exact 24", () => {
    expect(frameToTimecode(0, EXACT24)).toBe("00:00:00:00");
    expect(frameToTimecode(23, EXACT24)).toBe("00:00:00:23");
    expect(frameToTimecode(24, EXACT24)).toBe("00:00:01:00");
    expect(frameToTimecode(24 * 3600 + 24 * 60 + 25, EXACT24)).toBe("01:01:01:01");
    expect(timecodeToFrame("01:01:01:01", EXACT24)).toBe(24 * 3600 + 24 * 60 + 25);
  });
  it("labels 23.976 with 24 frames per timecode second", () => {
    expect(frameToTimecode(23, NTSC24)).toBe("00:00:00:23");
    expect(frameToTimecode(24, NTSC24)).toBe("00:00:01:00");
  });
  it("round-trips arbitrary frames", () => {
    for (const f of [0, 1, 239, 86400, 12345]) {
      expect(timecodeToFrame(frameToTimecode(f, NTSC24), NTSC24)).toBe(f);
    }
  });
  it("rejects out-of-range fields", () => {
    expect(() => timecodeToFrame("00:00:00:24", EXACT24)).toThrow();
    expect(() => timecodeToFrame("00:61:00:00", EXACT24)).toThrow();
    expect(() => frameToTimecode(-1, EXACT24)).toThrow();
    expect(() => frameToTimecode(1.5, EXACT24)).toThrow();
  });
});

describe("filmstrip position mapping", () => {
  it("is half-open: position 1.0 maps to the LAST frame, not numFrames", () => {
    expect(positionToFrame(1, 3588)).toBe(3587);
    expect(positionToFrame(0, 3588)).toBe(0);
  });
  it("clamps out-of-range positions", () => {
    expect(positionToFrame(-0.5, 100)).toBe(0);
    expect(positionToFrame(1.5, 100)).toBe(99);
  });
  it("frameToPosition inverts within one tile", () => {
    for (const f of [0, 100, 3587]) {
      expect(positionToFrame(frameToPosition(f, 3588), 3588)).toBe(f);
    }
  });
});

describe("cut list validation (mirrors gateway rules)", () => {
  it("accepts a valid list", () => {
    expect(validateCuts([233, 610, 3000], 3588)).toBeNull();
    expect(validateCuts([], 3588)).toBeNull();
  });
  it("rejects frame 0, out-of-range, non-increasing, non-integer", () => {
    expect(validateCuts([0], 3588)).toMatch(/outside/);
    expect(validateCuts([3588], 3588)).toMatch(/outside/);
    expect(validateCuts([100, 100], 3588)).toMatch(/increasing/);
    expect(validateCuts([100, 50], 3588)).toMatch(/increasing/);
    expect(validateCuts([1.5], 3588)).toMatch(/integer/);
  });
});

describe("fpsOptions / defaultPreviewFPS", () => {
  it("offers only divisors of the source rate, full first, never above source", () => {
    const opts = fpsOptions(EXACT24);
    expect(opts.map((o) => o.divisor)).toEqual([1, 2, 3, 4, 6, 8, 12]);
    expect(opts[0]).toMatchObject({ value: 24, label: "24 (full)" });
    expect(opts[1]).toMatchObject({ value: 12, label: "12 (½ rate)" });
    expect(Math.max(...opts.map((o) => o.value))).toBe(24);
  });
  it("labels NTSC rates professionally (23.98, not 23.976 or 24)", () => {
    const opts = fpsOptions(NTSC24);
    expect(opts[0].label).toBe("23.98 (full)");
    expect(opts[1]).toMatchObject({ value: 11.99, label: "11.99 (½ rate)" });
  });
  it("default preview is the source's full rate", () => {
    expect(defaultPreviewFPS(EXACT24)).toMatchObject({ divisor: 1, value: 24 });
    expect(defaultPreviewFPS(NTSC24).value).toBeCloseTo(23.98, 2);
  });
  it("drops sub-1fps divisors", () => {
    const opts = fpsOptions(parseRational("6/1"));
    expect(opts.map((o) => o.divisor)).toEqual([1, 2, 3, 4, 6]);
  });
});

describe("cutsToRanges", () => {
  it("tiles [0, numFrames) with no gaps or overlaps", () => {
    const ranges = cutsToRanges([233, 610], 3588);
    expect(ranges).toEqual([
      [0, 233],
      [233, 610],
      [610, 3588],
    ]);
  });
  it("no cuts → one scene", () => {
    expect(cutsToRanges([], 100)).toEqual([[0, 100]]);
  });
});
