import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ViewIn3D } from "./ViewIn3D";

const QUEST =
  "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.1.0.0 Chrome/126.0.0.0 VR Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";

const FILES = { mvhevc: "https://x/m.mov", sbs: "https://x/s.mp4", half_sbs: "https://x/h.mp4" };

beforeAll(() => {
  HTMLMediaElement.prototype.play = function play() {
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause() {};
  HTMLMediaElement.prototype.load = function load() {};
});

function asBrowser(ua: string, touch = 0, xr = false): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  Object.defineProperty(navigator, "maxTouchPoints", { value: touch, configurable: true });
  if (xr) Object.defineProperty(navigator, "xr", { value: {}, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (navigator as { xr?: unknown }).xr;
  delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
});

describe("View in 3D (S3D-47)", () => {
  it("on Vision Pro plays the spatial video full screen from the tap", () => {
    asBrowser(MAC, 5, true);
    const full = vi.fn(() => Promise.resolve());
    HTMLElement.prototype.requestFullscreen = full;
    render(<ViewIn3D files={FILES} />);
    const button = screen.getByTestId("view-in-3d");
    expect(button.textContent).toBe("View in 3D");
    expect(button.getAttribute("data-format")).toBe("mvhevc");
    expect(screen.queryByTestId("view-in-3d-hint")).toBeNull();
    fireEvent.click(button);
    const video = screen.getByTestId("view-in-3d-video") as HTMLVideoElement;
    expect(video.src).toBe("https://x/m.mov");
    expect(video.controls).toBe(true);
    expect(full).toHaveBeenCalledTimes(1);
    expect(full.mock.contexts[0]).toBe(video);
  });

  it("on Quest plays the half side by side with the one-line hint", () => {
    asBrowser(QUEST);
    HTMLElement.prototype.requestFullscreen = vi.fn(() => Promise.resolve());
    render(<ViewIn3D files={FILES} />);
    expect(screen.getByTestId("view-in-3d").getAttribute("data-format")).toBe("half_sbs");
    expect(screen.getByTestId("view-in-3d-hint").textContent).toBe(
      "In the player's view options, choose 3D side by side.",
    );
  });

  it("falls back to the webkit API when there is no standard one", () => {
    asBrowser(QUEST);
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const saved = proto.requestFullscreen;
    proto.requestFullscreen = undefined;
    const webkit = vi.fn();
    proto.webkitRequestFullscreen = webkit;
    render(<ViewIn3D files={FILES} />);
    fireEvent.click(screen.getByTestId("view-in-3d"));
    expect(webkit).toHaveBeenCalledTimes(1);
    proto.requestFullscreen = saved;
    delete proto.webkitRequestFullscreen;
  });

  it("on a computer it is a plain Full screen", () => {
    asBrowser(MAC);
    HTMLElement.prototype.requestFullscreen = vi.fn(() => Promise.resolve());
    render(<ViewIn3D files={FILES} />);
    expect(screen.getByTestId("view-in-3d").textContent).toBe("Full screen");
    expect(screen.queryByTestId("view-in-3d-hint")).toBeNull();
  });

  it("shows nothing without a playable file", () => {
    asBrowser(MAC);
    render(<ViewIn3D files={{ depth: "https://x/d.mkv" }} />);
    expect(screen.queryByTestId("view-in-3d")).toBeNull();
  });
});
