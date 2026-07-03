import { describe, expect, it } from "vitest";

import {
  clampDepthRes,
  DEFAULT_DEPTH_RES,
  depthResChoices,
  depthResLabel,
  maxDepthResForAspect,
} from "./depthRes";

describe("depthResChoices", () => {
  it("offers all presets for a large near-square source and a source-native ceiling", () => {
    // 2160×2160 (1:1) → short side 2160, aspect ceiling ⌊√8.5e6⌋→2520 (no bind);
    // the 2520 preset exceeds the short side and is dropped; source-native =
    // ⌊2160/14⌋·14 = 2156 is added as the ceiling.
    const c = depthResChoices(2160, 2160);
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
    const c = depthResChoices(100, 100);
    expect(c.every((x) => x.value >= 140)).toBe(true);
    expect(c[0].value).toBe(140);
  });

  it("caps a wide 4K source below its short side at the aspect VRAM ceiling", () => {
    // 5162×2160 (2.39:1) 4K: short side 2160 (→2156), but the B200 ceiling binds
    // first at ⌊√(8.5e6/2.3898)⌋→1876. This is the reported bug — before the
    // aspect cap the source-native 2156 (11.11 MP) was offered and Modal
    // rejected it mid-job.
    const c = depthResChoices(5162, 2160);
    expect(c.map((x) => x.value)).toEqual([518, 700, 980, 1148, 1442, 1876]);
    expect(c[c.length - 1]).toMatchObject({ value: 1876, name: "source native" });
    expect(c.every((x) => x.value <= 1876)).toBe(true);
  });

  it("defaults height to width (square) when only the short side is passed", () => {
    // single-arg call = 1:1, ceiling never binds below the short side.
    expect(depthResChoices(980)).toEqual(depthResChoices(980, 980));
  });
});

describe("maxDepthResForAspect", () => {
  it("is aspect-aware and orientation-agnostic, floored to ×14", () => {
    // working_mp = depth_res² × elongation ≤ 8.5; res = ⌊√(8.5e6/elong)⌋ to ×14.
    expect(maxDepthResForAspect(1920, 1080)).toBe(2184); // 16:9  → √(8.5e6/1.778)=2186
    expect(maxDepthResForAspect(3840, 1608)).toBe(1876); // 2.39:1 → √(8.5e6/2.388)=1885
    expect(maxDepthResForAspect(2160, 2160)).toBe(2520); // 1:1   → √8.5e6=2915, clamped to rail
    // orientation-agnostic: portrait gives the same cap as landscape.
    expect(maxDepthResForAspect(1608, 3840)).toBe(maxDepthResForAspect(3840, 1608));
  });

  it("the returned max is always runnable (working MP ≤ ceiling)", () => {
    for (const [w, h] of [[3840, 1608], [1920, 1080], [4096, 1716]]) {
      const res = maxDepthResForAspect(w, h);
      const workMP = (res * res * Math.max(w, h)) / Math.min(w, h) / 1e6;
      expect(workMP).toBeLessThanOrEqual(8.5);
    }
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
