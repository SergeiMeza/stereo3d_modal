/**
 * Owner 2026-11-07: Overview's "Source details" — folded by default, the
 * viewer's open state remembered, only the rows the gateway reports.
 * Synthetic data only.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/api/types";
import { appStore } from "@/lib/state/stores";

import { SourceDetails, sourceDetailsOpenAtom, sourceRows } from "./SourceDetails";

function project(over: Partial<Project> = {}): Project {
  return {
    project_id: "src000000001",
    name: "synthetic-clip",
    source_bytes: 1_610_612_736,
    analyze: { state: "succeeded", credit_cents: 0, credit_available: false },
    probe: {
      width: 3840,
      height: 2160,
      fps: 29.97,
      fps_rational: "30000/1001",
      duration_s: 312.4,
      num_frames: 9363,
      bit_rate: 41_200_000,
      vfr: true,
      counted_frames: 9686,
    },
    has_bars: true,
    crop: "3840:1600:0:280",
    remove_bars: true,
    dynamic_range: "hlg",
    created_at: "2026-11-07T00:00:00Z",
    updated_at: "2026-11-07T00:00:00Z",
    ...over,
  } as Project;
}

const row = (label: string) => screen.queryByTestId(`detail-${label}`)?.querySelector("dd")?.textContent ?? null;

beforeEach(() => {
  window.localStorage.clear();
  act(() => appStore.set(sourceDetailsOpenAtom, false));
});
afterEach(() => cleanup());

describe("Source details (owner 2026-11-07)", () => {
  it("is folded by default, opens on a tap, and remembers that for this viewer", () => {
    render(<SourceDetails project={project()} />);
    expect(screen.queryByTestId("source-details")).toBeNull();
    fireEvent.click(screen.getByTestId("source-details-toggle"));
    expect(screen.getByTestId("source-details")).toBeTruthy();
    expect(window.localStorage.getItem("svs:overview:source-details-open")).toBe("true");
    cleanup();
    render(<SourceDetails project={project({ project_id: "src000000002" })} />);
    expect(screen.getByTestId("source-details")).toBeTruthy();
  });

  it("shows what the gateway reports, with Run details' formatters", () => {
    act(() => appStore.set(sourceDetailsOpenAtom, true));
    render(<SourceDetails project={project()} />);
    const list = screen.getByTestId("source-details");
    expect(within(list).getAllByRole("term").map((t) => t.textContent)).toEqual([
      "Size",
      "Length",
      "Resolution",
      "Frame rate",
      "Frames",
      "Video bitrate",
      "Colour",
      "Black bars",
    ]);
    expect(row("Size")).toBe("1.5 GB");
    expect(row("Length")).toBe("5 min 12 s");
    expect(row("Resolution")).toBe("3840×2160 · 4K");
    expect(row("Frame rate")).toBe("29.97 fps · variable, up to 31.01 fps");
    expect(row("Frames")).toBe("9,363");
    expect(row("Video bitrate")).toBe("41 Mbit/s");
    expect(row("Colour")).toBe("HDR (HLG)");
    expect(row("Black bars")).toBe("Detected · picture 3840×1600 · removed in your 3D");
  });

  it("leaves out what it doesn't know; never an estimate", () => {
    const p = project({ dynamic_range: undefined, has_bars: undefined, crop: undefined });
    p.probe = { width: 1920, height: 1080, fps: 24, fps_rational: "24/1", duration_s: 45, num_frames: 1080 };
    const labels = sourceRows(p).map((r) => r.label);
    expect(labels).toEqual(["Size", "Length", "Resolution", "Frame rate", "Frames"]);
    expect(sourceRows(p).find((r) => r.label === "Frame rate")?.value).toBe("24 fps");
    expect(sourceRows(project({ has_bars: false })).find((r) => r.label === "Black bars")?.value).toBe("None");
    expect(sourceRows(project({ remove_bars: false })).find((r) => r.label === "Black bars")?.value).toBe(
      "Detected · picture 3840×1600 · kept in your 3D",
    );
  });

  it("with the gateway's source_details (00175): file, codec, colour, rotation, audio, 3D and camera", () => {
    const p = project({
      source_details: {
        details_read: true,
        file: { name: "synthetic-clip.mov", bytes: 1_610_612_736, container: "mov", duration_s: 312.4 },
        video: {
          width: 3840,
          height: 2160,
          fps: 29.97,
          fps_rational: "30000/1001",
          vfr: false,
          frames: 9363,
          counted_frames: null,
          codec: "hevc",
          profile: "Main 10",
          bit_depth: 10,
          bitrate_bps: 41_200_000,
          color_transfer: "arib-std-b67",
          color_primaries: "bt2020",
          rotation: 90,
        },
        source_crop: "3840:1600:0:280",
        audio: { codec: "aac", channels: 2, sample_rate: 48000, bitrate_bps: 256_000 },
        stereo: { spatial: true, layout: "mvhevc" },
        camera: { make: "Apple", model: "iPhone 16 Pro" },
      },
    });
    const rows = Object.fromEntries(sourceRows(p).map((r) => [r.label, r.value]));
    expect(rows).toMatchObject({
      File: "synthetic-clip.mov",
      Size: "1.5 GB",
      Container: "MOV",
      Length: "5 min 12 s",
      Resolution: "3840×2160 · 4K",
      "Frame rate": "29.97 fps",
      Frames: "9,363",
      Codec: "HEVC (H.265) · Main 10",
      "Bit depth": "10-bit",
      "Video bitrate": "41 Mbit/s",
      Colour: "HDR (HLG) · BT.2020",
      Rotation: "90°",
      "Black bars": "Detected · picture 3840×1600 · removed in your 3D",
      Audio: "AAC · stereo · 48 kHz · 256 kbit/s",
      "Spatial or 3D": "Spatial video (MV-HEVC)",
      Camera: "Apple iPhone 16 Pro",
    });
  });

  it("an older project (details_read false): codec, audio, 3D and camera are unknown, so left out", () => {
    const p = project({
      dynamic_range: undefined,
      source_details: {
        details_read: false,
        file: { name: null, bytes: 1_610_612_736, container: "mp4", duration_s: 312.4 },
        video: { width: 3840, height: 2160, fps: 29.97, frames: 9363, rotation: null },
        audio: null,
        stereo: null,
        camera: null,
      },
    });
    const labels = sourceRows(p).map((r) => r.label);
    expect(labels).toEqual(["Size", "Container", "Length", "Resolution", "Frame rate", "Frames", "Video bitrate", "Black bars"]);
    // read files with no sound say so
    const silent = project({ source_details: { details_read: true, audio: null, stereo: { spatial: false, layout: null }, camera: null } });
    const rows = Object.fromEntries(sourceRows(silent).map((r) => [r.label, r.value]));
    expect(rows.Audio).toBe("None");
    expect(rows["Spatial or 3D"]).toBe("No, 2D");
    expect(rows.Camera).toBeUndefined();
  });

  it("works with storage that throws (private mode)", () => {
    const get = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<SourceDetails project={project()} />);
    fireEvent.click(screen.getByTestId("source-details-toggle"));
    expect(screen.getByTestId("source-details")).toBeTruthy();
    get.mockRestore();
  });
});
