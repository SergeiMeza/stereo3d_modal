/**
 * China mode (owner 2026-11-08): wherever a samples-CDN file would play,
 * preview or download, the region notice stands in; everywhere else the
 * players and links stay as they are.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Samples } from "@/components/landing/Samples";
import { DownloadsList } from "@/components/steps/DownloadsList";
import { ViewIn3D } from "@/components/steps/ViewIn3D";
import { PreviewViewer } from "@/components/workspace/PreviewViewer";
import type { PreviewPlayer } from "@/components/workspace/usePreviewPlayer";
import type { Probe } from "@/lib/api/types";
import { SAMPLES_CDN } from "@/lib/samples";

const NOTICE = "Sample videos aren't available in your region yet.";

const SAMPLE_FILES = {
  sbs: `${SAMPLES_CDN}/sunset-session-sbs.mp4`,
  mvhevc: `${SAMPLES_CDN}/sunset-session-spatial.mov`,
};
const SIGNED_FILES = {
  sbs: "https://storage.googleapis.com/b/out/sbs.mp4?sig=1",
  mvhevc: "https://storage.googleapis.com/b/out/mvhevc.mov?sig=1",
};

function chinaMode(): void {
  document.cookie = "s3d_region=cn; Path=/";
}

beforeAll(() => {
  HTMLMediaElement.prototype.play = function play() {
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause() {};
  HTMLMediaElement.prototype.load = function load() {};
});

afterEach(() => {
  cleanup();
  document.cookie = "s3d_region=; Path=/; Max-Age=0";
});

describe("DownloadsList", () => {
  it("China mode: the notice instead of the sample's players and links", () => {
    chinaMode();
    render(<DownloadsList downloads={SAMPLE_FILES} />);
    expect(screen.getByTestId("sample-region-notice").textContent).toBe(NOTICE);
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("a")).toBeNull();
  });

  it("China mode: other runs' signed files still play and download", () => {
    chinaMode();
    render(<DownloadsList downloads={SIGNED_FILES} />);
    expect(screen.queryByTestId("sample-region-notice")).toBeNull();
    expect(screen.getByTestId("preview-sbs").getAttribute("src")).toBe(SIGNED_FILES.sbs);
  });

  it("outside China mode the sample plays and downloads as before", () => {
    render(<DownloadsList downloads={SAMPLE_FILES} />);
    expect(screen.queryByTestId("sample-region-notice")).toBeNull();
    expect(screen.getByTestId("preview-sbs").getAttribute("src")).toBe(SAMPLE_FILES.sbs);
    expect([...document.querySelectorAll("a")].map((a) => a.getAttribute("href")).sort()).toEqual(
      [SAMPLE_FILES.mvhevc, SAMPLE_FILES.sbs].sort(),
    );
  });
});

describe("View in 3D", () => {
  it("China mode: the notice instead of the button for a sample file", () => {
    chinaMode();
    render(<ViewIn3D files={SAMPLE_FILES} />);
    expect(screen.getByTestId("sample-region-notice").textContent).toBe(NOTICE);
    expect(screen.queryByTestId("view-in-3d")).toBeNull();
  });

  it("outside China mode the button plays the sample", () => {
    render(<ViewIn3D files={SAMPLE_FILES} />);
    expect(screen.getByTestId("view-in-3d")).toBeTruthy();
    expect(screen.queryByTestId("sample-region-notice")).toBeNull();
  });
});

describe("landing samples", () => {
  it("China mode: the poster stays, no play button, the notice instead of the downloads", () => {
    chinaMode();
    render(<Samples />);
    const tile = screen.getByTestId("sample-sunset-session");
    expect(within(tile).getByRole("img")).toBeTruthy();
    expect(within(tile).queryAllByRole("button")).toHaveLength(0);
    expect(tile.querySelector("a")).toBeNull();
    expect(tile.querySelector("video")).toBeNull();
    expect(within(tile).getByTestId("sample-region-notice").textContent).toBe(NOTICE);
  });

  it("outside China mode the tile plays and downloads as before", () => {
    render(<Samples />);
    const tile = screen.getByTestId("sample-sunset-session");
    expect(tile.querySelectorAll("a")).toHaveLength(3);
    expect(within(tile).queryByTestId("sample-region-notice")).toBeNull();
  });
});

describe("project preview player", () => {
  const POSTER = "/landing/samples/sunset-session-poster-1600.webp";
  const player: PreviewPlayer = {
    playing: false,
    play() {},
    pause() {},
    toggle() {},
    seekToFrame() {},
    speed: 1,
    setSpeed() {},
    muted: true,
    setMuted() {},
  };
  function viewer(previewUrl: string) {
    return (
      <PreviewViewer
        probe={{ width: 3840, height: 2160 } as Probe}
        fps={{ num: 25, den: 1 }}
        playhead={0}
        previewUrl={previewUrl}
        thumbs={[{ frame: 0, url: POSTER }]}
        player={player}
        videoRef={{ current: null }}
        onStep={() => {}}
      />
    );
  }

  it("China mode: the sample's own-origin thumbnail with the notice, no video", () => {
    chinaMode();
    render(viewer(`${SAMPLES_CDN}/sunset-session-2d.mp4`));
    expect(screen.queryByTestId("preview-video")).toBeNull();
    expect(screen.getByTestId("viewer-frame").getAttribute("src")).toBe(POSTER);
    expect(screen.getByTestId("sample-region-notice").textContent).toBe(NOTICE);
  });

  it("outside China mode the sample's proxy plays", () => {
    const url = `${SAMPLES_CDN}/sunset-session-2d.mp4`;
    render(viewer(url));
    expect(screen.getByTestId("preview-video").getAttribute("src")).toBe(url);
    expect(screen.queryByTestId("sample-region-notice")).toBeNull();
  });
});
