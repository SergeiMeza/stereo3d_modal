/**
 * Deliver page tests: the inheritance chips (last depth run's depth_res +
 * the Stereo page's shared localStorage draft), production request bodies
 * forwarding EXACTLY those values with per-field "pipeline default"
 * escapes, the reuse discount / from-scratch re-quote, and the absence of
 * any displacement control (pro steps have none), and the shared review
 * area (the latest production output as a follower of the main preview).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

import downloadsFixture from "../../../fixtures/downloads_succeeded.json";
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

async function getQuote(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Get quote" }));
  await screen.findByTestId("quote-breakdown");
}

describe("DeliverPanel inheritance", () => {
  it("summary chips show the Depth page's depth_res and the Stereo page's tweaks FIRST", () => {
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    seedStereoDraft(project.project_id);
    renderPanel(project);

    expect(screen.getByTestId("deliver-chip-depth").textContent).toBe(
      "Depth 1442 ×14 (from Depth page)",
    );
    expect(screen.getByTestId("deliver-chip-stereo").textContent).toBe(
      "2 scene overrides + depth_scale 1.10 (from Stereo page)",
    );
  });

  it("production sends THE SAME depth_res, scene_overrides and depth_scale the previews set", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    seedStereoDraft(project.project_id);
    renderPanel(project);

    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    // exact body: no displacement, no target_fps (Full), inherited values in
    expect(bodies[0]).toEqual({
      step: "production",
      preset: "1080p",
      formats: ["mvhevc", "half_sbs"],
      inpaint: "propainter",
      depth_res: 1442,
      depth_scale: 1.1,
      scene_overrides: [
        { first: 0, displacement: 0.02 },
        { first: FIRST_CUT, shot_type: "wide" },
      ],
      platform: "web",
    });
  });

  it("per-field 'use pipeline default' escapes drop the inherited values", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    seedStereoDraft(project.project_id);
    renderPanel(project);

    await user.click(
      screen.getByRole("checkbox", { name: "Use pipeline default depth resolution" }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Use pipeline defaults (adaptive)" }),
    );
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].depth_res).toBeUndefined();
    expect(bodies[0].depth_scale).toBeUndefined();
    expect(bodies[0].scene_overrides).toBeUndefined();
  });

  it("the uploaded depth map is an explicit opt-in that beats the inherited depth run", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
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

    expect(
      screen.getByTestId("deliver-chip-depth-upload").textContent,
    ).toContain("graded-depth.mp4");

    await user.click(
      screen.getByRole("checkbox", {
        name: "Use uploaded depth map (skips the depth stage)",
      }),
    );
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].use_uploaded_depth).toBe(true);
    expect(bodies[0].depth_res).toBeUndefined(); // beats the inherited 1442
    const stages = screen.getByTestId("quote-reuse-stages");
    expect(stages.textContent).toContain("depth");
  });

  it("states the fallbacks when there is nothing to inherit", () => {
    renderPanel(); // no conversions, no stereo draft
    expect(screen.getByTestId("deliver-chip-depth-none").textContent).toMatch(
      /No depth run yet/,
    );
    expect(screen.getByTestId("deliver-chip-stereo-none").textContent).toMatch(
      /No Stereo-page tweaks/,
    );
  });
});

describe("DeliverPanel controls", () => {
  it("offers presets and 4 formats (no TB) — no edge-quality choice, no fps control", () => {
    renderPanel();

    const preset = document.getElementById("production-preset") as HTMLSelectElement;
    expect([...preset.options].map((o) => o.value)).toEqual([
      "1080p",
      "qhd",
      "3k",
      "4k",
    ]);
    expect(preset.value).toBe("1080p");

    const formats = screen.getByRole("group", { name: "Formats" });
    const boxes = within(formats).getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    for (const name of ["SBS", "Half-SBS", "Anaglyph", "MV-HEVC"]) {
      expect(within(formats).getByRole("checkbox", { name })).toBeDefined();
    }
    expect(within(formats).queryByRole("checkbox", { name: "TB" })).toBeNull();
    expect(
      (within(formats).getByRole("checkbox", { name: "MV-HEVC" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (within(formats).getByRole("checkbox", { name: "Half-SBS" }) as HTMLInputElement)
        .checked,
    ).toBe(true);

    // no edge-quality choice this release — every run is full quality
    // (inpaint=propainter on the wire), and internal terms never render
    expect(document.getElementById("production-inpaint")).toBeNull();
    expect(document.body.textContent).not.toMatch(/ProPainter|[Ss]platted/);

    // no frame-rate control in this version — production runs at the
    // source rate (the gateway default when target_fps is absent)
    expect(document.getElementById("production-fps")).toBeNull();
    expect(screen.queryByText(/frame rate/i)).toBeNull();

    // NO displacement slider anywhere on the pro steps
    expect(screen.queryByText(/displacement/i)).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("blocks checkout while every format is deselected", async () => {
    const user = userEvent.setup();
    renderPanel();

    const formats = screen.getByRole("group", { name: "Formats" });
    await user.click(within(formats).getByRole("checkbox", { name: "MV-HEVC" }));
    await user.click(within(formats).getByRole("checkbox", { name: "Half-SBS" }));

    const quoteBtn = screen.getByRole("button", { name: "Get quote" }) as HTMLButtonElement;
    expect(quoteBtn.disabled).toBe(true);
    expect(screen.getByText("Select at least one format")).toBeDefined();

    // re-selecting any format unblocks
    await user.click(within(formats).getByRole("checkbox", { name: "SBS" }));
    expect(quoteBtn.disabled).toBe(false);
    expect(screen.queryByText("Select at least one format")).toBeNull();
  });

  it("Stretched edges prices a production render at ×0.6 with a user-facing breakdown line", async () => {
    const user = userEvent.setup();
    const bodies = captureQuoteBodies();
    renderPanel();

    await getQuote(user);
    const fullSubtotal = screen.getByTestId("quote-subtotal").textContent;
    expect(screen.queryByTestId("quote-inpaint-multiplier")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Edge handling"), "backward");
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ warp: "backward", inpaint: "none" });
    expect(screen.getByTestId("quote-inpaint-multiplier").textContent).toBe("×0.6");
    // explained in the user's terms — never the renderer/model names
    const breakdown = screen.getByTestId("quote-breakdown").textContent!;
    expect(breakdown).toContain("Stretched edges");
    expect(breakdown).not.toMatch(/backward|gather|ProPainter|inpaint/i);
    const cents = (s: string | null) => Math.round(parseFloat(s!.replace(/[^0-9.]/g, "")) * 100);
    expect(cents(screen.getByTestId("quote-subtotal").textContent)).toBe(
      Math.round(cents(fullSubtotal) * 0.6),
    );
  });

  it("shows the reuse discount and drops it when re-quoted from scratch", async () => {
    const user = userEvent.setup();
    const project = fixtureProject();
    const prior = seededDepthRun(project.project_id);
    // strip the inherited depth_res so the quote stays at the preset default
    prior.params = { preset: "draft", formats: ["anaglyph"] };
    mockDb.conversions.set(prior.conversion_id, structuredClone(prior));
    project.conversions = [prior];
    renderPanel(project);

    await getQuote(user);
    // 1080p production at 150¢ cost × 3 margin full rate: 1121¢ base; the
    // letterboxed 2.39:1 fixture prices the preset-default 980 depth at
    // ×1.345 on the 0.35 share → $12.56 subtotal; −40% (depth 35% +
    // preprocess 5%) reuse discount = 502¢; −50¢ analyze credit → $7.04
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$12.56");
    const stages = screen.getByTestId("quote-reuse-stages");
    expect(stages.textContent).toContain("depth");
    expect(stages.textContent).toContain("preprocess");
    expect(screen.getByTestId("quote-reuse-discount").textContent).toBe("−$5.02");
    expect(screen.getByTestId("quote-total").textContent).toBe("$7.04");

    // from-scratch toggle re-quotes without the reuse discount
    await user.click(screen.getByLabelText(/Start from scratch/));
    await waitFor(() =>
      expect(screen.getByTestId("quote-total").textContent).toBe("$10.80"),
    );
    expect(screen.queryByTestId("quote-reuse-discount")).toBeNull();
    expect(screen.queryByTestId("quote-reuse-stages")).toBeNull();
  });

  it("prices the inherited depth resolution into the production quote (0.35 depth share)", async () => {
    const user = userEvent.setup();
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id, 1442)];
    renderPanel(project);

    await getQuote(user);
    // base $11.21; aspect factor 1442²×2.391/(980²×16⁄9) = 2.912 on 35% of
    // the base → 1121 × (1 + 0.35 × 1.912) = 1871¢; reuse −748 → 1123;
    // −112 bulk − 50¢ credit → $9.61
    expect(screen.getByTestId("quote-base").textContent).toBe("$11.21");
    expect(screen.getByTestId("quote-depth-factor").textContent).toBe("×2.91");
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$18.71");
    expect(screen.getByTestId("quote-total").textContent).toBe("$9.61");
  });
});

describe("DeliverPanel review area (one transport)", () => {
  /** A succeeded production run seeded into the mock db (so /downloads works). */
  function seededProductionRun(projectId: string): Conversion {
    const conv: Conversion = {
      conversion_id: "priorprod0001",
      state: "succeeded",
      kind: "video",
      project_id: projectId,
      step: "production",
      params: { preset: "1080p", formats: ["mvhevc", "sbs"], inpaint: "propainter" },
      quote: { amount_cents: 200, currency: "usd" },
      progress: 1,
      outputs: ["mvhevc", "sbs"],
      created_at: "2026-07-02T08:00:00Z",
      updated_at: "2026-07-02T08:05:00Z",
    };
    mockDb.conversions.set(conv.conversion_id, structuredClone(conv));
    return conv;
  }

  it("hints at the review area before any production run — source preview + timeline still render", () => {
    renderPanel();
    expect(screen.getByTestId("preview-video")).toBeDefined();
    expect(screen.getByTestId("filmstrip")).toBeDefined();
    // active-picture (crop) overlay on the preview, same as Media/Cut
    expect(screen.getByTestId("crop-overlay")).toBeDefined();
    expect(
      screen.getByText(/Run production to review the final output/),
    ).toBeDefined();
    expect(screen.queryByTestId("deliver-output-video")).toBeNull();
  });

  it("plays the last production run's best playable output BESIDE the source, synced to the main transport", async () => {
    const project = fixtureProject();
    project.conversions = [seededProductionRun(project.project_id)];
    renderPanel(project);

    // mvhevc is never browser-playable — sbs is picked
    const output = (await screen.findByTestId(
      "deliver-output-video",
    )) as HTMLVideoElement;
    expect(output.getAttribute("src")).toBe(
      (downloadsFixture.downloads as Record<string, string>).sbs,
    );
    expect(screen.getByTestId("deliver-output-video-badge").textContent).toBe("sbs");

    const master = screen.getByTestId("preview-video") as HTMLVideoElement;
    const playSpy = vi.spyOn(output, "play");
    fireEvent.click(screen.getByLabelText("Play preview"));
    expect(playSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(master, "duration", { value: 100, configurable: true });
    Object.defineProperty(output, "duration", { value: 100, configurable: true });
    master.currentTime = 30;
    fireEvent.timeUpdate(master);
    expect(output.currentTime).toBeCloseTo(30, 5);
  });
});
