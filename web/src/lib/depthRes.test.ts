import { describe, expect, it } from "vitest";

import {
  clampDepthRes,
  DEFAULT_DEPTH_RES,
  depthResChoices,
  depthResLabel,
} from "./depthRes";

describe("depthResChoices", () => {
  it("offers all presets for a large source and a source-native ceiling", () => {
    // 3840×2160 → short side 2160; the 2520 preset exceeds it and is dropped;
    // source-native = ⌊2160/14⌋·14 = 2156 is added as the ceiling.
    const c = depthResChoices(2160);
    expect(c.map((x) => x.value)).toEqual([
      518, 700, 980, 1148, 1442, 2100, 2156,
    ]);
    expect(c[c.length - 1]).toMatchObject({ value: 2156, name: "source native" });
  });

  it("drops presets above the source short side (portrait/small sources)", () => {
    // a 720p-short source (e.g. 720×1280 portrait, short side 720): presets
    // above 720 gone; source-native = ⌊720/14⌋·14 = 714.
    const c = depthResChoices(720);
    expect(c.map((x) => x.value)).toEqual([518, 700, 714]);
    expect(c[c.length - 1]).toMatchObject({ value: 714, name: "source native" });
  });

  it("relabels a preset that lands exactly on the source ceiling as source native", () => {
    // short side 980 → source-native ⌊980/14⌋·14 = 980, which IS the Standard
    // preset; it must appear once, labeled source native (not duplicated).
    const c = depthResChoices(980);
    expect(c.map((x) => x.value)).toEqual([518, 700, 980]);
    expect(c[c.length - 1]).toMatchObject({ value: 980, name: "source native" });
    expect(c.filter((x) => x.value === 980)).toHaveLength(1);
  });

  it("never returns a value below the gateway minimum", () => {
    // a tiny source floors to the gateway min (140), not below.
    const c = depthResChoices(100);
    expect(c.every((x) => x.value >= 140)).toBe(true);
    expect(c[0].value).toBe(140);
  });
});

describe("clampDepthRes", () => {
  it("keeps the default when it is an offered choice", () => {
    const c = depthResChoices(2160);
    expect(clampDepthRes(DEFAULT_DEPTH_RES, c)).toBe(980);
  });

  it("snaps the default down to the ceiling for a small source", () => {
    // short side 720 → choices [518,700,714]; the 980 default clamps to 714.
    const c = depthResChoices(720);
    expect(clampDepthRes(980, c)).toBe(714);
  });

  it("falls back to the smallest choice when nothing is at or below", () => {
    const c = depthResChoices(600); // [518, 588]
    expect(clampDepthRes(100, c)).toBe(c[0].value);
  });
});

describe("depthResLabel", () => {
  it("shows the value with an optional quality name — NO GPU tier", () => {
    expect(depthResLabel({ value: 980, name: "Standard" })).toBe("980 — Standard");
    expect(depthResLabel({ value: 700 })).toBe("700");
    expect(depthResLabel({ value: 2156, name: "source native" })).toBe(
      "2156 — source native",
    );
  });
});
