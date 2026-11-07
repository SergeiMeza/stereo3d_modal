import { describe, expect, it } from "vitest";

import { BITRATES, bitrateField, offeredBitrate } from "./makeControls";

describe("bitrate choices (owner 2026-11-07: no 20 Mbit/s)", () => {
  it("offers Automatic, Match the source, 40, 60 and 100", () => {
    expect(BITRATES.map((b) => b.value)).toEqual(["auto", "match_source", 40, 60, 100]);
  });

  it("reads a saved 20 Mbit/s as Automatic and sends no bitrate", () => {
    expect(offeredBitrate(20)).toBe("auto");
    expect(bitrateField(20)).toEqual({});
  });

  it("keeps the offered choices", () => {
    expect(bitrateField(60)).toEqual({ bitrate: 60 });
    expect(bitrateField("match_source")).toEqual({ bitrate: "match_source" });
    expect(bitrateField("auto")).toEqual({});
  });
});
