import { describe, expect, it } from "vitest";

import sitemap from "@/app/sitemap";

import { DEVICE_PAGES, devicePage, WORKS_WITH } from "./devices";

describe("device pages (S3D-51)", () => {
  it("has one short page per device", () => {
    expect(DEVICE_PAGES.map((d) => d.slug)).toEqual([
      "vision-pro",
      "galaxy-xr",
      "meta-quest",
      "pico",
      "steam-frame",
      "xreal",
      "viture",
      "rayneo",
      "meta-vr-glasses",
    ]);
    for (const d of DEVICE_PAGES) {
      expect(d.lines.length).toBeGreaterThanOrEqual(3);
      expect(d.lines.length).toBeLessThanOrEqual(5);
    }
    expect(devicePage("galaxy-xr")!.title).toBe("Watch 3D videos on Samsung Galaxy XR");
    expect(devicePage("galaxy-xr")!.lines.join(" ")).toMatch(/Gallery or Files/);
    expect(devicePage("xreal")!.lines.join(" ")).toMatch(/3D \(SBS\) mode/);
    expect(devicePage("meta-vr-glasses")!.upcoming).toBe("spring 2027");
    for (const w of WORKS_WITH) if (w.slug) expect(devicePage(w.slug)).toBeDefined();
  });

  it("Meta Quest: the full side-by-side file, Half SBS at 4K and above or when too large (owner 2026-11-04)", () => {
    const q = devicePage("meta-quest")!;
    expect(q.lines[0]).toBe("Make any video 3D and pick the Side by side file.");
    expect(q.lines.join(" ")).toMatch(/For 4K and above, or when the file is too large to copy or stream, pick Side by side \(half size\) instead\./);
    expect(q.lines).toContain("In the player, choose 3D side by side.");
    expect(q.fileNote).toMatch(/^A Side by side file/);
  });

  it("lists every device page in the sitemap", () => {
    const urls = sitemap().map((e) => e.url);
    for (const d of DEVICE_PAGES) {
      expect(urls.some((u) => u.endsWith(`/devices/${d.slug}`))).toBe(true);
    }
  });
});
