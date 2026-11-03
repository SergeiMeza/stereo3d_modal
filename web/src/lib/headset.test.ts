import { describe, expect, it } from "vitest";

import { detectClient, playChoice } from "./headset";

const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const QUEST =
  "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.1.0.0 SamsungBrowser/4.0 Chrome/126.0.0.0 VR Safari/537.36";
const PICO =
  "Mozilla/5.0 (Linux; Android 10; Pico 4 Build/QKQ1.200811.002) AppleWebKit/537.36 (KHTML, like Gecko) PicoBrowser/3.3.38 Chrome/105.0.5195.68 VR Safari/537.36";

describe("headset detection (S3D-47)", () => {
  it("Vision Pro Safari names itself a Mac but has touch and WebXR", () => {
    expect(detectClient({ userAgent: MAC_SAFARI, maxTouchPoints: 5, xr: {} })).toBe("vision");
    // a real Mac: no touch, no WebXR
    expect(detectClient({ userAgent: MAC_SAFARI, maxTouchPoints: 0 })).toBe("desktop");
    expect(detectClient({ userAgent: MAC_SAFARI, maxTouchPoints: 5 })).toBe("desktop");
  });

  it("Samsung Galaxy XR by its model or Android XR", () => {
    expect(
      detectClient({
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; SM-I610) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      }),
    ).toBe("galaxyxr");
    expect(detectClient({ userAgent: "Mozilla/5.0 (Linux; Android XR) Chrome/141" })).toBe("galaxyxr");
    expect(playChoice("galaxyxr", { sbs: "s", half_sbs: "h" })).toEqual({
      format: "sbs",
      url: "s",
      stereo: true,
    });
  });

  it("Quest and Pico by their user agent", () => {
    expect(detectClient({ userAgent: QUEST })).toBe("quest");
    expect(detectClient({ userAgent: PICO })).toBe("pico");
    expect(detectClient({ userAgent: "Mozilla/5.0 (iPhone)" })).toBe("desktop");
    expect(detectClient(undefined)).toBe("desktop");
  });

  it("plays the file each headset shows in 3D, and falls back to full screen", () => {
    const all = { mvhevc: "m", sbs: "s", half_sbs: "h" };
    expect(playChoice("vision", all)).toEqual({ format: "mvhevc", url: "m", stereo: true });
    expect(playChoice("quest", all)).toEqual({ format: "half_sbs", url: "h", stereo: true });
    expect(playChoice("pico", all)).toEqual({ format: "sbs", url: "s", stereo: true });
    expect(playChoice("quest", { sbs: "s" })).toEqual({ format: "sbs", url: "s", stereo: true });
    // Vision Pro with only side by side: flat
    expect(playChoice("vision", { sbs: "s" })).toEqual({ format: "sbs", url: "s", stereo: false });
    // a computer plays a side by side picture flat
    expect(playChoice("desktop", all)).toEqual({ format: "sbs", url: "s", stereo: false });
    expect(playChoice("desktop", { depth: "d" })).toBeNull();
  });
});
