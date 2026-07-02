/**
 * Scene-profile interchange tests: the export document shape (every scene
 * with Auto values + draft overrides, display-only timecode), the
 * import-reads-back-ONLY-first/override/depth_scale doctrine (auto and
 * timecode are never parsed), round-tripping, and the gateway-shaped
 * validation with human-readable errors.
 */

import { describe, expect, it } from "vitest";

import type { ProfileShot } from "@/lib/api/types";
import { cutsToRanges, frameToTimecode, parseRational } from "@/lib/frames";

import {
  exportStereoProfile,
  parseStereoProfile,
  STEREO_PROFILE_KIND,
  type StereoProfileFile,
} from "./stereoProfile";
import type { StereoDraft } from "./stereoStore";

const FPS = parseRational("24/1");
const CUTS = [100, 250];
const N = 400;
const RANGES = cutsToRanges(CUTS, N); // [0,100) [100,250) [250,400)
const STARTS = [0, ...CUTS];
const VERSION = 3;

const SHOTS: ProfileShot[] = [
  {
    first_src: 0,
    last_src: 100,
    shot_type: "standard",
    displacement: 0.012,
    placement: [-1, 0.3],
  },
  {
    first_src: 100,
    last_src: 250,
    shot_type: "close_up",
    displacement: 0.008,
    placement: [-1.1, 0.05],
  },
];
const shotFor = (start: number): ProfileShot | undefined =>
  SHOTS.find((s) => s.first_src <= start && start < s.last_src);

const DRAFT: StereoDraft = {
  overrides: {
    "0": { displacement: 0.02 },
    "100": { shot_type: "wide", passthrough: true }, // stashed tweak + 2D
  },
  depth_scale: 1.05,
};

function exported(draft: StereoDraft = DRAFT): string {
  return exportStereoProfile({
    draft,
    ranges: RANGES,
    fps: FPS,
    scenesVersion: VERSION,
    shotFor,
  });
}

describe("exportStereoProfile", () => {
  it("writes one row per scene: half-open ranges, display timecode, Auto values, and the draft's overrides", () => {
    const doc = JSON.parse(exported()) as StereoProfileFile;
    expect(doc.kind).toBe(STEREO_PROFILE_KIND);
    expect(doc.scenes_version).toBe(VERSION);
    expect(doc.depth_scale).toBe(1.05);

    expect(doc.scenes).toHaveLength(3);
    expect(doc.scenes[0]).toEqual({
      scene: 1,
      first: 0,
      last: 100,
      timecode: frameToTimecode(0, FPS),
      auto: { shot_type: "standard", displacement: 0.012, placement: [-1, 0.3] },
      override: { displacement: 0.02 },
    });
    // scene 2 keeps the STASHED tweak alongside passthrough (draft shape)
    expect(doc.scenes[1].override).toEqual({
      shot_type: "wide",
      passthrough: true,
    });
    // scene 3: no profiled shot, no override — bare range only
    expect(doc.scenes[2]).toEqual({
      scene: 3,
      first: 250,
      last: N,
      timecode: frameToTimecode(250, FPS),
    });
  });
});

describe("parseStereoProfile", () => {
  it("round-trips the export back into the SAME draft", () => {
    expect(parseStereoProfile(exported(), STARTS, VERSION)).toEqual(DRAFT);
  });

  it("reads ONLY first/override/depth_scale — auto values are never imported", () => {
    const doc = JSON.parse(exported({ overrides: {}, depth_scale: 1 })) as StereoProfileFile;
    // every scene has auto values or ranges, none has an override
    const draft = parseStereoProfile(JSON.stringify(doc), STARTS, VERSION);
    expect(draft).toEqual({ overrides: {}, depth_scale: 1 });
  });

  it("defaults a missing depth_scale to 1 and skips empty overrides", () => {
    const draft = parseStereoProfile(
      JSON.stringify({
        kind: STEREO_PROFILE_KIND,
        scenes: [{ first: 0, override: {} }],
      }),
      STARTS,
      VERSION,
    );
    expect(draft).toEqual({ overrides: {}, depth_scale: 1 });
  });

  it("rejects non-JSON and files without the kind marker", () => {
    expect(() => parseStereoProfile("Scene,Start\n1,0", STARTS, VERSION)).toThrow(
      /not valid JSON/,
    );
    expect(() => parseStereoProfile("{}", STARTS, VERSION)).toThrow(
      /Not a scene-profile file/,
    );
    expect(() =>
      parseStereoProfile(JSON.stringify({ kind: "cuts" }), STARTS, VERSION),
    ).toThrow(/Not a scene-profile file/);
  });

  it("rejects an override whose first does not start a current scene, naming the version mismatch", () => {
    const doc = JSON.parse(exported()) as StereoProfileFile;
    doc.scenes[0].first = 50; // not a scene start
    doc.scenes_version = VERSION - 1;
    expect(() => parseStereoProfile(JSON.stringify(doc), STARTS, VERSION)).toThrow(
      new RegExp(
        `frame 50 does not start a scene.*v${VERSION - 1}.*v${VERSION}`,
      ),
    );
    // same cut list (same version) → no version hint
    doc.scenes_version = VERSION;
    expect(() => parseStereoProfile(JSON.stringify(doc), STARTS, VERSION)).toThrow(
      /frame 50 does not start a scene on the current cut list\./,
    );
  });

  it("validates the gateway's ranges: displacement (0, 0.03], depth_scale [0.3, 1.5], known shot_type", () => {
    const withOverride = (override: unknown, depthScale?: number) =>
      JSON.stringify({
        kind: STEREO_PROFILE_KIND,
        ...(depthScale !== undefined ? { depth_scale: depthScale } : {}),
        scenes: [{ first: 0, override }],
      });
    expect(() =>
      parseStereoProfile(withOverride({ displacement: 0.05 }), STARTS, VERSION),
    ).toThrow(/displacement must be in \(0, 0.03\]/);
    expect(() =>
      parseStereoProfile(withOverride({ displacement: 0 }), STARTS, VERSION),
    ).toThrow(/displacement/);
    expect(() =>
      parseStereoProfile(withOverride({ shot_type: "macro" }), STARTS, VERSION),
    ).toThrow(/shot_type must be one of/);
    expect(() =>
      parseStereoProfile(withOverride({ displacement: 0.01 }, 2), STARTS, VERSION),
    ).toThrow(/depth_scale must be a number in \[0.3, 1.5\]/);
  });

  it("ignores passthrough: false and non-true values", () => {
    const draft = parseStereoProfile(
      JSON.stringify({
        kind: STEREO_PROFILE_KIND,
        scenes: [
          { first: 0, override: { passthrough: false, displacement: 0.01 } },
        ],
      }),
      STARTS,
      VERSION,
    );
    expect(draft.overrides["0"]).toEqual({ displacement: 0.01 });
  });
});
