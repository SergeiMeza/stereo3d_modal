import { describe, expect, it } from "vitest";

import { EDGE_OPTIONS, EDGE_LABELS } from "@/components/steps/outputOptions";

import { resolutionName, runSummary } from "./glossary";

describe("edge style names (S3D-29)", () => {
  it("offers Stretched then Filled, never ranked", () => {
    expect(EDGE_OPTIONS.map((m) => EDGE_LABELS[m])).toEqual([
      "Stretched",
      "Filled",
    ]);
  });

  it("names old per-frame fill runs as no longer offered", () => {
    expect(runSummary({ preset: "1080p", formats: ["sbs"], inpaint: "migan" })).toBe(
      "1080p · Side by side · Fast fill (no longer offered)",
    );
    expect(
      runSummary({ preset: "4k", formats: ["sbs"], inpaint: "none", warp: "backward" }),
    ).toBe("4K · Side by side · Stretched edges");
    expect(runSummary({ preset: "4k", formats: ["sbs"], inpaint: "propainter" })).toBe(
      "4K · Side by side · Filled edges",
    );
  });
});

describe("resolutionName above 4K", () => {
  it("names 5K, 6K and 8K sources by their real size", () => {
    expect(resolutionName({ width: 7680, height: 4320 })).toBe("8K");
    expect(resolutionName({ width: 5760, height: 3240 })).toBe("6K");
    expect(resolutionName({ width: 5120, height: 2880 })).toBe("5K");
    expect(resolutionName({ width: 3840, height: 2160 })).toBe("4K");
  });
});
