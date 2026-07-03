/**
 * Scene-profile interchange (Stereo page import/export) — the Cut tab's
 * cuts-CSV pattern applied to the per-scene 3D parameters.
 *
 * Export writes ONE JSON document per project: the scene table (half-open
 * [first, last) SOURCE-frame ranges — frame doctrine, never timestamps)
 * with each scene's profiled Auto values AND the user's draft override,
 * plus the master depth_scale. The auto block and timecode are context for
 * a human editing the file; import reads back ONLY `first`, `override`,
 * and the top-level `depth_scale` — exactly the data that feeds
 * scene_overrides on the wire.
 *
 * Import validates the way the gateway will (override `first` must start a
 * CURRENT scene; displacement in (0, 0.03]; depth_scale in [0.3, 1.5]) and
 * throws with a human-readable message, so a profile exported against a
 * different cut list fails loudly instead of sending misaligned frames.
 */

import type { ProfileShot, ShotType } from "@/lib/api/types";
import { frameToTimecode, type RationalFPS } from "@/lib/frames";

import type { RowOverride, StereoDraft } from "./stereoStore";

/** The valid shot_type vocabulary — shared with the Stereo page's selects. */
export const SHOT_TYPES: readonly ShotType[] = [
  "close_up",
  "standard",
  "dynamic",
  "wide",
];

/** User-facing names for the shot classes — the wire values are internal
 * snake_case terms and must not appear in UI copy. What they mean (the tips
 * sheet carries the full explanations): the profiler classifies each scene
 * by how far the action is from the camera — close_up (subject near the
 * camera: gentle depth, slight pop-out), standard (mid-distance: balanced
 * around the screen plane), wide (establishing/far shot: depth behind the
 * screen like a window), dynamic (the distance CHANGES during the scene, so
 * the tuning ramps across it). */
export const SHOT_TYPE_LABELS: Record<ShotType, string> = {
  close_up: "Close-up",
  standard: "Standard",
  dynamic: "Dynamic",
  wide: "Wide",
};

export const STEREO_PROFILE_KIND = "stereo-scene-profile";

/** One exported scene row. Everything except `first` and `override` is
 * display/context only and ignored on import. */
export interface StereoProfileScene {
  scene: number; // 1-based, display only
  first: number; // scene start, SOURCE-frame index (0 or a cuts value)
  last: number; // exclusive end (next cut or num_frames)
  timecode: string; // display only, never parsed back
  /** the profiled Auto values (project.scene_profile), when present */
  auto?: Pick<ProfileShot, "shot_type" | "displacement" | "placement">;
  /** the user's draft edits for this scene, when any */
  override?: RowOverride;
}

export interface StereoProfileFile {
  kind: typeof STEREO_PROFILE_KIND;
  scenes_version: number;
  depth_scale: number;
  scenes: StereoProfileScene[];
}

/** Serialize the CURRENT Stereo-page state — every scene with its Auto
 * values (when profiled) and the draft's overrides — as pretty JSON. */
export function exportStereoProfile(args: {
  draft: StereoDraft;
  ranges: Array<[number, number]>;
  fps: RationalFPS;
  scenesVersion: number;
  shotFor: (start: number) => ProfileShot | undefined;
}): string {
  const { draft, ranges, fps, scenesVersion, shotFor } = args;
  const doc: StereoProfileFile = {
    kind: STEREO_PROFILE_KIND,
    scenes_version: scenesVersion,
    depth_scale: draft.depth_scale,
    scenes: ranges.map(([first, last], i) => {
      const shot = shotFor(first);
      const override = draft.overrides[first];
      return {
        scene: i + 1,
        first,
        last,
        timecode: frameToTimecode(first, fps),
        ...(shot
          ? {
              auto: {
                shot_type: shot.shot_type,
                displacement: shot.displacement,
                placement: shot.placement,
              },
            }
          : {}),
        ...(override && Object.keys(override).length > 0 ? { override } : {}),
      };
    }),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse an exported scene profile back into a Stereo draft. Reads ONLY
 * each scene's `first` + `override` and the top-level `depth_scale`;
 * validates against the CURRENT scene starts (0 and the cuts) and the
 * gateway's ranges. Throws Error (human message) on anything invalid. */
export function parseStereoProfile(
  text: string,
  validStarts: number[],
  currentVersion: number,
): StereoDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(
      "The file is not valid JSON — export a scene profile from this page to see the expected shape.",
    );
  }
  if (!isRecord(raw) || raw.kind !== STEREO_PROFILE_KIND) {
    throw new Error(
      `Not a scene-profile file — expected {"kind": "${STEREO_PROFILE_KIND}"}.`,
    );
  }

  let depthScale = 1;
  if (raw.depth_scale !== undefined) {
    if (
      typeof raw.depth_scale !== "number" ||
      raw.depth_scale < 0.3 ||
      raw.depth_scale > 1.5
    ) {
      throw new Error("depth_scale must be a number in [0.3, 1.5].");
    }
    depthScale = raw.depth_scale;
  }

  if (!Array.isArray(raw.scenes)) {
    throw new Error("The profile has no scenes array — nothing to import.");
  }

  /** Version hint for range errors: a mismatch is the usual reason. */
  const versionNote =
    typeof raw.scenes_version === "number" && raw.scenes_version !== currentVersion
      ? ` (the file was exported against scene cuts v${raw.scenes_version}; this project is at v${currentVersion})`
      : "";

  const valid = new Set(validStarts);
  const overrides: StereoDraft["overrides"] = {};
  for (const entry of raw.scenes as unknown[]) {
    if (!isRecord(entry)) throw new Error("A scenes[] entry is not an object.");
    if (!isRecord(entry.override)) continue; // auto scene — nothing to read
    const o = entry.override;

    if (typeof entry.first !== "number" || !Number.isInteger(entry.first)) {
      throw new Error(
        "A scene override is missing its integer `first` frame — overrides carry whole source-frame numbers only.",
      );
    }
    if (!valid.has(entry.first)) {
      throw new Error(
        `The override at frame ${entry.first} does not start a scene on the current cut list${versionNote}.`,
      );
    }

    const row: RowOverride = {};
    if (o.shot_type !== undefined) {
      if (!SHOT_TYPES.includes(o.shot_type as ShotType)) {
        throw new Error(
          `Scene at frame ${entry.first}: shot_type must be one of ${SHOT_TYPES.join("|")}.`,
        );
      }
      row.shot_type = o.shot_type as ShotType;
    }
    if (o.displacement !== undefined) {
      if (
        typeof o.displacement !== "number" ||
        o.displacement <= 0 ||
        o.displacement > 0.03
      ) {
        throw new Error(
          `Scene at frame ${entry.first}: displacement must be in (0, 0.03].`,
        );
      }
      row.displacement = o.displacement;
    }
    if (o.passthrough === true) row.passthrough = true;
    if (Object.keys(row).length > 0) overrides[entry.first] = row;
  }

  return { overrides, depth_scale: depthScale };
}
