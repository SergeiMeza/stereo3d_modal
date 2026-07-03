import { describe, expect, it } from "vitest";

import {
  clampDepthRes,
  DEFAULT_DEPTH_RES,
  depthContentDims,
  depthResChoices,
  depthResLabel,
  maxDepthResForAspect,
} from "./depthRes";

describe("depthResChoices", () => {
  it("offers all presets for a large 16:9 source and a source-native ceiling", () => {
    // 3840×2160 → short side 2160; the 2520 preset exceeds it and is dropped.
    // The 16:9 aspect cap (⌊√(8.5e6/1.78)⌋ ≈ 2184 → 2184) is above the short
    // side, so the source short side binds: source-native = ⌊2160/14⌋·14 = 2156,
    // which coincides with the 2156 preset and is relabeled.
    const c = depthResChoices(3840, 2160);
    expect(c.map((x) => x.value)).toEqual([
      518, 700, 980, 1148, 1442, 1610, 1806, 2100, 2156,
    ]);
    expect(c[c.length - 1]).toMatchObject({ value: 2156, name: "source native" });
  });

  it("caps a WIDE (2.39:1) source at the aspect VRAM ceiling, not the short side", () => {
    // 4096×1716 (2.39:1), short side 1716 → source-native would be 1708, but the
    // VRAM ceiling binds first: ⌊√(8.5e6/2.387)⌋ ≈ 1886 → 1876... which is ABOVE
    // 1708 here. Use a taller-short wide source where the aspect cap truly binds:
    // 5120×2142 (2.39:1), short side 2142 → source cap ⌊2142/14⌋·14 = 2142, but
    // aspect cap ⌊√(8.5e6/2.390)⌋ = 1885 → ⌊1885/14⌋·14 = 1876. 1876 < 2142, so
    // the aspect cap binds and the top choice is labeled "aspect max".
    const c = depthResChoices(5120, 2142);
    expect(c.every((x) => x.value <= 1876)).toBe(true);
    expect(c.map((x) => x.value)).toEqual([
      518, 700, 980, 1148, 1442, 1610, 1806, 1876,
    ]);
    expect(c[c.length - 1]).toMatchObject({ value: 1876, name: "aspect max" });
    // Every offered value stays within the VRAM ceiling.
    const long = 5120,
      short = 2142;
    for (const ch of c) {
      const workMP = (ch.value * ch.value * (long / short)) / 1e6;
      expect(workMP).toBeLessThanOrEqual(8.5);
    }
  });

  it("drops presets above the source short side (portrait/small sources)", () => {
    // 720×1280 portrait, short side 720: presets above 720 gone; the portrait
    // aspect cap is well above 720, so source-native = ⌊720/14⌋·14 = 714 binds.
    const c = depthResChoices(720, 1280);
    expect(c.map((x) => x.value)).toEqual([518, 700, 714]);
    expect(c[c.length - 1]).toMatchObject({ value: 714, name: "source native" });
  });

  it("relabels a preset that lands exactly on the source ceiling as source native", () => {
    // 980×980 square → source-native ⌊980/14⌋·14 = 980, which IS the Standard
    // preset; it must appear once, labeled source native (not duplicated).
    const c = depthResChoices(980, 980);
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
});

describe("depthContentDims", () => {
  const probe = { width: 3840, height: 2160 };

  it("returns the crop W×H for a letterboxed source — the dims depth runs on", () => {
    // 2.39:1 film in a 16:9 container: preprocess removes the bars, so depth
    // works on 3840×1606, and the choices must bind at THAT aspect. This is
    // the exact failure seen in prod: the container aspect offered 2100
    // (7.84 MP at 16:9), Modal then failed at 2100²×2.39 = 10.54 MP.
    expect(depthContentDims(probe, "3840:1606:0:277")).toEqual({
      width: 3840,
      height: 1606,
    });
    const dims = depthContentDims(probe, "3840:1606:0:277")!;
    const c = depthResChoices(dims.width, dims.height);
    // cropped short side 1606 → source cap ⌊1606/14⌋·14 = 1596 binds (the
    // 2.39:1 aspect cap is 1876, higher). 2100 is no longer offered.
    expect(c.map((x) => x.value)).toEqual([518, 700, 980, 1148, 1442, 1596]);
    expect(c[c.length - 1]).toMatchObject({ value: 1596, name: "source native" });
  });

  it("falls back to the probe when the crop is absent or malformed", () => {
    expect(depthContentDims(probe, undefined)).toEqual(probe);
    expect(depthContentDims(probe, "")).toEqual(probe);
    expect(depthContentDims(probe, "not-a-crop")).toEqual(probe);
    expect(depthContentDims(probe, "3840:0:0:0")).toEqual(probe);
  });

  it("returns null when the probe is unknown", () => {
    expect(depthContentDims(undefined, "3840:1606:0:277")).toBeNull();
    expect(depthContentDims({ width: 0, height: 0 }, undefined)).toBeNull();
  });
});

describe("maxDepthResForAspect", () => {
  it("returns a lower cap for wider aspects (work_mp = res² × elongation)", () => {
    // Square (elongation 1) allows the most; wider allows progressively less.
    expect(maxDepthResForAspect(1000, 1000)).toBeGreaterThan(
      maxDepthResForAspect(1780, 1000),
    );
    expect(maxDepthResForAspect(1780, 1000)).toBeGreaterThan(
      maxDepthResForAspect(2390, 1000),
    );
  });

  it("keeps every returned cap within the 8.5 MP VRAM ceiling", () => {
    for (const [w, h] of [
      [1920, 1080],
      [2560, 1080], // 2.39:1
      [1080, 1920],
      [1000, 1000],
    ] as const) {
      const res = maxDepthResForAspect(w, h);
      const elong = Math.max(w, h) / Math.min(w, h);
      expect((res * res * elong) / 1e6).toBeLessThanOrEqual(8.5);
    }
  });

  it("returns a multiple of 14", () => {
    expect(maxDepthResForAspect(2560, 1080) % 14).toBe(0);
  });
});

describe("clampDepthRes", () => {
  it("keeps the default when it is an offered choice", () => {
    const c = depthResChoices(3840, 2160);
    expect(clampDepthRes(DEFAULT_DEPTH_RES, c)).toBe(980);
  });

  it("snaps the default down to the ceiling for a small source", () => {
    // 720×1280 → choices [518,700,714]; the 980 default clamps to 714.
    const c = depthResChoices(720, 1280);
    expect(clampDepthRes(980, c)).toBe(714);
  });

  it("falls back to the smallest choice when nothing is at or below", () => {
    const c = depthResChoices(600, 600); // [518, 588]
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
