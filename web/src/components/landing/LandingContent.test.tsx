import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(screen.getAllByRole("link", { name: "Make your first 3D video" })).toHaveLength(1); // hero
    // the closing section: one button, no prices (owner 2026-11)
    expect(screen.getAllByRole("link", { name: "Make your 3D video" })).toHaveLength(1);
    expect(screen.queryByTestId("final-price")).toBeNull();
    expect((await screen.findByTestId("hero-from-price")).textContent).toBe(
      "from $3 a minute at 24 fps",
    );
    expect(screen.getByTestId("hero-step-2").textContent).toBe("A few seconds in 3D.");
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
    // the hero's 2D → 3D loop: H.264 MP4 first (iPhone Safari paints VP9
    // WebM black), then WebM, a poster for reduced motion
    const hero = screen.getByTestId("hero-loop");
    const video = hero.querySelector("video");
    expect(video?.getAttribute("poster")).toBe("/landing/hero/diner-2d-3d.jpg");
    expect(
      [...hero.querySelectorAll("source")].map((s) => s.getAttribute("type")),
    ).toEqual(["video/mp4", "video/webm"]);
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
    // playing red-cyan: H.264 first there too
    const tile = screen.getByTestId("sample-pool-day");
    fireEvent.click(within(tile).getByRole("button", { name: "Red-cyan" }));
    expect([...tile.querySelectorAll("source")].map((s) => s.getAttribute("src"))).toEqual([
      "https://cdn.public.spatial-video-studio.com/samples/2026-11/loops/pool-day-redcyan-loop.mp4",
      "https://cdn.public.spatial-video-studio.com/samples/2026-11/loops/pool-day-redcyan-loop.webm",
    ]);
  });
});

describe("Lifelike story (2026-11)", () => {
  it("sells Lifelike, shows the real app and drops Classic and beta copy", async () => {
    render(
      <AuthProvider>
        <LandingContent />
      </AuthProvider>,
    );
    const points = screen.getByTestId("lifelike-points");
    expect(points.textContent).toContain("Every moment rebuilt as a real 3D scene.");
    expect(points.textContent).toContain("Any length, up to 8K");
    expect(points.textContent).toContain("Your original in one eye");
    expect(points.textContent).toContain("At Cinema sizes, 5K to 8K");
    expect(screen.getByTestId("teams-line").textContent).toBe(
      "For teams: Business and Studio plans. See plans",
    );
    expect(points.textContent).toContain("Foveated Detail");
    // prices only in the one hero line (owner 2026-11)
    expect(screen.getByTestId("hero-limits").textContent).toContain("Any length, up to 8K. See prices");
    expect(screen.getByTestId("hero-limits").textContent).not.toMatch(/save|\$/);
    // How it looks: a phone shot per screen, Make 3D open on the tabs
    for (const id of ["projects", "make-3d", "tracker", "files"]) {
      expect(
        screen.getByTestId(`tour-${id}`).querySelector("img")?.getAttribute("src"),
      ).toContain(`%2Flanding%2Fui%2F${id}-phone.webp`);
    }
    const tab = screen.getByRole("tab", { name: "Make 3D" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("tabpanel").querySelector("img")?.getAttribute("src"),
    ).toContain("%2Flanding%2Fui%2Fmake-3d.webp");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bbeta\b/i);
    expect(text).not.toMatch(/VFX|frame-exact|conversion house|directed by you/i);
  });
});
