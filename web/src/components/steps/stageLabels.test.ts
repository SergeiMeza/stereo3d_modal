import { describe, expect, it } from "vitest";

import { stageLabel } from "./stageLabels";

describe("stageLabel", () => {
  it("maps internal stage names to product copy", () => {
    expect(stageLabel("preprocess")).toBe("Preparing the video");
    expect(stageLabel("profile_scenes")).toBe("Profiling scenes");
    expect(stageLabel("video_depth")).toBe("Computing the depth map");
    expect(stageLabel("video_stereo")).toBe("Building the 3D video");
    expect(stageLabel("encode_mvhevc")).toBe("Encoding MV-HEVC");
  });

  it("strips the worker/model bracket detail — internal terms never render", () => {
    expect(stageLabel("video_stereo[propainter]")).toBe("Building the 3D video");
    expect(stageLabel("video_stereo[m2svid]")).toBe("Building the 3D video");
    expect(stageLabel("video_depth[2814:3587]")).toBe("Computing the depth map");
  });

  it("unknown stages fall back to the sanitized base name — a bracket suffix can never leak", () => {
    expect(stageLabel("new_stage[secret_model_v9]")).toBe("new stage");
  });
});
