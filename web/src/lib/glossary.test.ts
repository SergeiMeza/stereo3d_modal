import { describe, expect, it } from "vitest";

import { EDGE_OPTIONS, EDGE_LABELS } from "@/components/steps/outputOptions";

import { runSummary } from "./glossary";

describe("edge style names (S3D-29)", () => {
  it("offers Filled then Stretched, never ranked", () => {
    expect(EDGE_OPTIONS.map((m) => EDGE_LABELS[m])).toEqual([
      "Filled",
      "Stretched",
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
