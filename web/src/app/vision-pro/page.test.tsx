import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as analytics from "@/lib/analytics";
import { SAMPLES_CDN } from "@/lib/samples";

import VisionProPage, { generateMetadata, VISION_PRO_SAMPLES } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/vision-pro",
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("/vision-pro: the web app introduced for Apple Vision Pro", () => {
  it("has its title and canonical, and names no price", async () => {
    const meta = await generateMetadata();
    expect(meta.title).toBe("Lifelike 3D on Apple Vision Pro");
    expect(meta.alternates?.canonical).toBe("/vision-pro");
    expect(String(meta.description)).not.toContain("$");
  });

  it("names no other headset and has one button to /", async () => {
    const { container } = render(await VisionProPage());
    const text = container.textContent ?? "";
    for (const other of ["Quest", "Pico", "Galaxy", "side by side"])
      expect(text).not.toContain(other);
    expect(text).not.toContain("$");
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/"]);
  });

  it("lists the samples, each loading its spatial file only on the tap", async () => {
    const track = vi.spyOn(analytics, "track").mockImplementation(() => {});
    render(await VisionProPage());
    for (const slug of VISION_PRO_SAMPLES)
      expect(screen.getByTestId(`vision-pro-sample-${slug}`)).toBeTruthy();
    const video = screen
      .getByTestId("vision-pro-sample-river-stones")
      .querySelector("video")!;
    expect(video.getAttribute("src")).toBeNull();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    fireEvent.click(screen.getAllByRole("button", { name: "Watch in 3D" })[0]);
    expect(video.getAttribute("src")).toBe(
      `${SAMPLES_CDN}/river-stones-spatial.mov`,
    );
    expect(track).toHaveBeenCalledWith("vision_pro_sample_play", {
      slug: "river-stones",
    });
  });
});
