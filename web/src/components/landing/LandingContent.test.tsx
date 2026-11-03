import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { LandingContent } from "./LandingContent";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

describe("Landing hero (mock 12, S3D-46)", () => {
  it("leads with Lifelike 3D and takes its prices from GET /v1/pricing", async () => {
    render(
      <AuthProvider>
        <LandingContent />
      </AuthProvider>,
    );
    expect(screen.getByTestId("hero-eyebrow").textContent).toBe(
      "Lifelike 3D · our newest 3D technology",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Turn any video into lifelike 3D",
    );
    expect(
      screen.getByRole("link", { name: "Make your first 3D video" }),
    ).toBeTruthy();
    expect((await screen.findByTestId("hero-from-price")).textContent).toBe(
      "from $3 a minute at 24 fps",
    );
    expect(screen.getByTestId("hero-step-2").textContent).toBe(
      "A few seconds in 3D, from $1.",
    );
    // Works with, text only, each linking to its page (S3D-51)
    // Works with: the links in an sr-only list (not display:none), the
    // animated track aria-hidden and drawn twice for the loop (S3D-51)
    const links = screen.getByTestId("works-with-links");
    expect(links.className).toContain("sr-only");
    const hrefs = [...links.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/devices/galaxy-xr");
    expect(hrefs).toContain("/devices/meta-vr-glasses");
    expect(links.textContent).toContain("Ready for Meta VR Glasses, spring 2027");
    const track = screen.getByTestId("works-with-track");
    expect(track.getAttribute("aria-hidden")).toBe("true");
    expect(track.querySelectorAll(".works-set")).toHaveLength(2);
    expect(track.textContent).toContain("Ready for Meta VR Glasses, spring 2027");
    // no technical words on the page
    expect(document.body.textContent).not.toMatch(
      /splat|gaussian|depth map|warp|inpaint|model/i,
    );
  });
});

describe("Samples (2026-11)", () => {
  it("offers each clip for Vision Pro, side by side and as the 2D original", () => {
    render(
      <AuthProvider>
        <LandingContent />
      </AuthProvider>,
    );
    // before/after in the hero: a range input over two stills
    const compare = screen.getByTestId("hero-compare");
    expect(
      compare.querySelector('input[type="range"]')?.getAttribute("aria-label"),
    ).toBe("Compare your video with Lifelike 3D");
    for (const slug of [
      "mustang-golden-hour",
      "pool-day",
      "seoul-street",
      "diner-freeze",
      "matsuri-night",
    ]) {
      const tile = screen.getByTestId(`sample-${slug}`);
      const hrefs = [...tile.querySelectorAll("a")].map((a) => a.getAttribute("href"));
      expect(hrefs).toEqual([
        `https://cdn.public.spatial-video-studio.com/samples/2026-11/${slug}-spatial.mov`,
        `https://cdn.public.spatial-video-studio.com/samples/2026-11/${slug}-sbs.mp4`,
        `https://cdn.public.spatial-video-studio.com/samples/2026-11/${slug}-2d.mp4`,
      ]);
      expect(tile.textContent).toContain("Vision Pro (spatial video)");
      expect(tile.textContent).toContain(
        "Quest, Pico, Galaxy XR, XR glasses (side by side)",
      );
      // poster first: no video until asked to play
      expect(tile.querySelector("video")).toBeNull();
    }
  });
});
