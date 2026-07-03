/**
 * stepDownloads scopes a run's download links to what its step sells:
 * every job writes depth + depth_vis next to its formats, so unfiltered
 * lists offered a depth run's throwaway anaglyph, a stereo run's depth
 * map, and the 8-bit depth_vis everywhere — which exists only for in-app
 * playback and reads like a depth map to users.
 */

import { describe, expect, it } from "vitest";

import { stepDownloads } from "./DownloadsList";

const ALL: Record<string, string> = {
  anaglyph: "https://dl/anaglyph.mp4",
  sbs: "https://dl/sbs.mp4",
  half_sbs: "https://dl/half_sbs.mp4",
  mvhevc: "https://dl/mvhevc.mov",
  depth: "https://dl/depth.mp4",
  depth_vis: "https://dl/depth_vis.mp4",
};

describe("stepDownloads", () => {
  it("depth page: the depth map alone — not the preview format, never depth_vis", () => {
    expect(Object.keys(stepDownloads("depth_preview", ALL))).toEqual(["depth"]);
  });

  it("stereo page: stereo formats alone — no depth artifacts", () => {
    expect(Object.keys(stepDownloads("stereo_preview", ALL)).sort()).toEqual([
      "anaglyph",
      "half_sbs",
      "mvhevc",
      "sbs",
    ]);
  });

  it("production and the cross-step history keep every deliverable incl. the depth map", () => {
    for (const step of ["production", undefined, null, ""]) {
      const kept = Object.keys(stepDownloads(step, ALL)).sort();
      expect(kept).toEqual(["anaglyph", "depth", "half_sbs", "mvhevc", "sbs"]);
    }
  });

  it("depth_vis is never downloadable on any surface", () => {
    for (const step of ["depth_preview", "stereo_preview", "production", undefined]) {
      expect(stepDownloads(step, ALL)).not.toHaveProperty("depth_vis");
    }
  });

  it("preserves the signed URLs it keeps", () => {
    expect(stepDownloads("production", ALL).depth).toBe(ALL.depth);
  });
});
