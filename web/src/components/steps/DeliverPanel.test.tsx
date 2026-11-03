/**
 * Classic Make 3D (screen 10): sections, Classic's qualities up to 3K
 * each priced, the edge styles under Advanced with their prices, the
 * carried-over Depth / 3D look settings with their automatic escapes, the
 * uploaded depth map opt-in, and the reuse discount / from-scratch.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Conversion, Project, StepConversionRequest } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { DeliverPanel } from "./DeliverPanel";
import { saveStereoDraft } from "./stereoStore";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 50 }));

// jsdom's HTMLMediaElement.play/pause are "not implemented"; stub them to
// dispatch their events — the follower sync listens to exactly these.
beforeAll(() => {
  HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("pause"));
  };
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  mockDb.reset();
  vi.restoreAllMocks();
  window.localStorage.clear();
});
afterAll(() => server.close());

const FIXTURE = projectFixture as unknown as Project;
const VERSION = FIXTURE.scenes!.version;
const FIRST_CUT = FIXTURE.scenes!.cuts[0];

function fixtureProject(overrides: Partial<Project> = {}): Project {
  return {
    ...(structuredClone(projectFixture) as unknown as Project),
    ...overrides,
  };
}

/** A succeeded depth run whose depth_res Deliver should inherit. */
function seededDepthRun(projectId: string, depthRes = 1442): Conversion {
  const conv: Conversion = {
    conversion_id: "prior0000001",
    state: "succeeded",
    kind: "video",
    project_id: projectId,
    step: "depth_preview",
    params: {
      preset: "draft",
      formats: ["anaglyph"],
      inpaint: "none",
      depth_res: depthRes,
      target_fps: 12,
    },
    quote: { amount_cents: 50, currency: "usd" },
    progress: 1,
    outputs: ["anaglyph", "depth", "depth_vis"],
    created_at: "2026-07-02T08:00:00Z",
    updated_at: "2026-07-02T08:05:00Z",
  };
  mockDb.conversions.set(conv.conversion_id, structuredClone(conv));
  return conv;
}

/** The Stereo page's persisted draft: 2 overrides + depth_scale 1.1. */
function seedStereoDraft(projectId: string): void {
  saveStereoDraft(projectId, VERSION, {
    overrides: {
      "0": { displacement: 0.02 },
      [String(FIRST_CUT)]: { shot_type: "wide" },
    },
    depth_scale: 1.1,
  });
}

function renderPanel(project: Project = fixtureProject()) {
  const onProjectChanged = vi.fn();
  render(
    <AuthProvider>
      <DeliverPanel project={project} onProjectChanged={onProjectChanged} />
    </AuthProvider>,
  );
  return { onProjectChanged };
}

function captureQuoteBodies(): StepConversionRequest[] {
  const bodies: StepConversionRequest[] = [];
  server.events.on("request:start", ({ request }) => {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/quotes")
    ) {
      void request
        .clone()
        .json()
        .then((b) => bodies.push(b as StepConversionRequest));
    }
  });
  return bodies;
}

/** The page prices as you pick: wait for the price card's quote. */
async function priced() {
  await screen.findByTestId("quote-breakdown", {}, { timeout: 3000 });
}

/** Pick a quality tile. */
function pickQuality(p: string) {
  fireEvent.click(within(screen.getByTestId(`quality-${p}`)).getByRole("radio"));
}

/** Open Advanced. */
function openAdvanced() {
  (screen.getByTestId("classic-advanced") as HTMLDetailsElement).open = true;
}

describe("Classic Make 3D (screen 10)", () => {
  it("numbered sections, Red-cyan among the files, quality tiles up to 3K each priced, one button", async () => {
    renderPanel();
    expect(screen.getByTestId("move-to-lifelike-offer")).toBeTruthy();
    const files = within(screen.getByRole("group", { name: "Files you'll get" }));
    expect(files.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Vision Pro spatial video",
      "Side by side",
      "Side by side (half size)",
      "Red-cyan",
    ]);
    const tiles = within(screen.getByRole("radiogroup", { name: "Quality" }));
    const values = tiles.getAllByRole("radio").map((r) => r.closest("[data-testid]")!.getAttribute("data-testid"));
    expect(values.every((v) => !/4k|5k|6k|8k/.test(v!))).toBe(true);
    for (const v of values) {
      const p = v!.replace("quality-", "");
      await waitFor(() =>
        expect(screen.getByTestId(`quality-price-${p}`).textContent).toMatch(/^\$\d+\.\d\d$/),
      );
    }
    await priced();
    expect(screen.getByTestId("checkout-main").textContent).toMatch(/^Make 3D · \$\d+\.\d\d$/);
    expect(screen.queryByRole("button", { name: "Get quote" })).toBeNull();
    expect(screen.getByText("With stretched edges. You can change this under Advanced.")).toBeTruthy();
  });

  it("Advanced: edges Stretched then Filled, each priced, Stretched preselected; the pairs on the wire", async () => {
    const bodies = captureQuoteBodies();
    renderPanel();
    openAdvanced();
    const edges = within(screen.getByRole("radiogroup", { name: "Edges" }));
    expect(edges.getAllByRole("radio").map((r) => r.closest("label")!.textContent!.replace(/\$.*$|…$/, ""))).toEqual([
      "Stretched",
      "Filled",
    ]);
    expect((edges.getAllByRole("radio")[0] as HTMLInputElement).checked).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId("edge-price-stretched").textContent).toMatch(/^\$\d+\.\d\d$/),
    );
    expect(screen.getByTestId("edge-price-filled").textContent).toMatch(/^\$\d+\.\d\d$/);
    expect(document.body.textContent).not.toMatch(/visible stretching|propainter|backward/i);
    expect(document.body.textContent).not.toMatch(/MI-GAN|migan|fast fill/i);
    fireEvent.click(edges.getAllByRole("radio")[1]);
    await waitFor(() =>
      expect(
        bodies.some((b) => b.warp === undefined && b.inpaint === "propainter" && b.step === "production"),
      ).toBe(true),
    );
    expect(screen.getByText("With filled edges. You can change this under Advanced.")).toBeTruthy();
  });

  it("production sends THE SAME depth_res, scene_overrides and depth_scale the previews set", async () => {
    const bodies = captureQuoteBodies();
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    seedStereoDraft(project.project_id);
    renderPanel(project);
    openAdvanced();
    expect(screen.getByTestId("deliver-chip-depth").textContent).toBe(
      "1442 px (from the Depth page)",
    );
    expect(screen.getByTestId("deliver-chip-stereo").textContent).toBe(
      "2 scenes adjusted, 3D strength ×1.10 (from the 3D look page)",
    );
    pickQuality("1080p");
    await waitFor(() =>
      expect(bodies).toContainEqual({
        step: "production",
        preset: "1080p",
        formats: ["mvhevc", "sbs"],
        inpaint: "none",
        warp: "backward",
        depth_res: 1442,
        depth_scale: 1.1,
        scene_overrides: [
          { first: 0, displacement: 0.02 },
          { first: FIRST_CUT, shot_type: "wide" },
        ],
        platform: "web",
      }),
    );
  });

  it("the automatic escapes drop the inherited values", async () => {
    const bodies = captureQuoteBodies();
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    seedStereoDraft(project.project_id);
    renderPanel(project);
    openAdvanced();
    fireEvent.click(screen.getByRole("checkbox", { name: "Use automatic depth detail" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Use automatic 3D for every scene" }));
    await priced();
    await waitFor(() =>
      expect(
        bodies.some(
          (b) =>
            b.step === "production" &&
            b.depth_res === undefined &&
            b.depth_scale === undefined &&
            b.scene_overrides === undefined,
        ),
      ).toBe(true),
    );
  });

  it("the uploaded depth map is an explicit opt-in that beats the inherited depth run", async () => {
    const bodies = captureQuoteBodies();
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    project.depth_upload = {
      name: "graded-depth.mp4",
      frames: project.probe!.num_frames,
      width: project.probe!.width,
      height: project.probe!.height,
      bytes: 1 << 20,
      created_at: "2026-07-03T08:00:00Z",
    };
    mockDb.projects.get(project.project_id)!.depth_upload = project.depth_upload;
    renderPanel(project);
    openAdvanced();
    expect(screen.getByTestId("deliver-chip-depth-upload").textContent).toContain(
      "graded-depth.mp4",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Use my uploaded depth video" }));
    await waitFor(() =>
      expect(
        bodies.some((b) => b.use_uploaded_depth === true && b.depth_res === undefined),
      ).toBe(true),
    );
  });

  it("states the fallbacks when there is nothing to inherit", () => {
    renderPanel();
    openAdvanced();
    expect(screen.getByTestId("deliver-chip-depth-none").textContent).toMatch(/Standard/);
    expect(screen.getByTestId("deliver-chip-stereo-none").textContent).toMatch(/automatic 3D/);
  });

  it("blocks the button while every file is deselected", async () => {
    renderPanel();
    const files = within(screen.getByRole("group", { name: "Files you'll get" }));
    for (const c of files.getAllByRole("checkbox")) {
      if ((c as HTMLInputElement).checked) fireEvent.click(c);
    }
    expect((screen.getByTestId("checkout-main") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Pick at least one file")).toBeTruthy();
  });

  it("shows the reuse discount and drops it from scratch", async () => {
    const project = fixtureProject();
    const prior = seededDepthRun(project.project_id);
    prior.params = { preset: "draft", formats: ["anaglyph"] };
    mockDb.conversions.set(prior.conversion_id, structuredClone(prior));
    project.conversions = [prior];
    renderPanel(project);
    pickQuality("1080p");
    await waitFor(() => expect(screen.queryByTestId("quote-reuse-discount")).not.toBeNull(), {
      timeout: 3000,
    });
    const stages = screen.getByTestId("quote-reuse-stages");
    expect(stages.textContent).toContain("depth");
    expect(stages.textContent).toContain("preparation");
    openAdvanced();
    fireEvent.click(screen.getByLabelText(/Start from scratch/));
    await waitFor(() => expect(screen.queryByTestId("quote-reuse-discount")).toBeNull(), {
      timeout: 3000,
    });
  });
});

describe("Classic Bitrate (S3D-56)", () => {
  it("sits under Advanced and sends the choice", async () => {
    const bodies = captureQuoteBodies();
    renderPanel();
    openAdvanced();
    const select = screen.getByLabelText("Bitrate") as HTMLSelectElement;
    expect(select.value).toBe("auto");
    fireEvent.change(select, { target: { value: "100" } });
    await waitFor(() =>
      expect(bodies.some((b) => b.step === "production" && b.bitrate === 100)).toBe(true),
    );
  });
});
