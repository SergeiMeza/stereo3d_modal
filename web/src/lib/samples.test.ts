import { afterEach, describe, expect, it } from "vitest";

import { SAMPLES, SAMPLES_CDN, sampleMediaBlocked } from "./samples";

const CDN_FILE = `${SAMPLES_CDN}/sunset-session-sbs.mp4`;

describe("sampleMediaBlocked (China mode, owner 2026-11-08)", () => {
  afterEach(() => {
    document.cookie = "s3d_region=; Path=/; Max-Age=0";
  });

  it("blocks samples-CDN files in China mode only", () => {
    expect(sampleMediaBlocked(CDN_FILE, "cn")).toBe(true);
    expect(sampleMediaBlocked(SAMPLES[0].loop.mp4, "cn")).toBe(true);
    expect(sampleMediaBlocked(SAMPLES[0].downloads[0].href, "cn")).toBe(true);
    expect(sampleMediaBlocked(CDN_FILE, "global")).toBe(false);
    // hydrating: the region isn't known yet
    expect(sampleMediaBlocked(CDN_FILE, null)).toBe(false);
  });

  it("never blocks other hosts or the web's own posters and thumbnails", () => {
    for (const url of [
      "https://storage.googleapis.com/bucket/out/sbs.mp4?X-Goog-Signature=abc",
      "https://cdn.public.spatial-video-studio.com.example.com/x.mp4",
      "https://public.spatial-video-studio.com/x.mp4",
      "/landing/samples/sunset-session-poster-1600.webp",
      SAMPLES[0].poster,
      "blob:http://localhost/123",
      "",
      null,
      undefined,
    ]) {
      expect(sampleMediaBlocked(url, "cn")).toBe(false);
    }
  });

  it("reads the visitor's region when none is given", () => {
    expect(sampleMediaBlocked(CDN_FILE)).toBe(false);
    document.cookie = "s3d_region=cn; Path=/";
    expect(sampleMediaBlocked(CDN_FILE)).toBe(true);
  });
});
