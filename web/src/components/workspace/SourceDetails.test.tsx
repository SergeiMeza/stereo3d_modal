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
      "Dynamic range",
      "Black bars",
    ]);
    expect(row("Size")).toBe("1.5 GB");
    expect(row("Length")).toBe("5 min 12 s");
    expect(row("Resolution")).toBe("3840×2160 · 4K");
    expect(row("Frame rate")).toBe("29.97 fps · variable, up to 31.01 fps");
    expect(row("Frames")).toBe("9,363");
    expect(row("Video bitrate")).toBe("41 Mbit/s");
    expect(row("Dynamic range")).toBe("HDR (HLG)");
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
