/**
 * Stereo page tests: per-scene rows derived from the fixture's REAL cuts
 * (frame ranges + timecodes via frames.ts, never hardcoded), scene_profile
 * seeding + the stale-profile warning, ONLY-changed-rows scene_overrides on
 * the wire (displacement top-level ABSENT; the per-scene numeric
 * displacement input is deliberately NOT rendered this release — imports
 * and the draft still carry it), the Deliver-parity output params
 * (resolution preset + MV-HEVC format; every run is full-quality inpaint,
 * ×1.6 — the cheap opt-out is not exposed), depth inheritance from the
 * Depth page (depth_res on the wire → reuse discount; picker when several
 * resolutions exist; "use pipeline default" escape), the ONE-transport
 * review area (the latest output — or the Depth run's depth map — as a
 * follower of the main preview), row-click seeking + active-row highlight,
 * localStorage draft persistence (the store Deliver inherits), per-scene 2D
 * passthrough (exactly {first, passthrough:true} on the wire; draft depth
 * values stashed and restored), and the free shot-profiling action.
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

import { useState } from "react";

import type {
  Conversion,
  Project,
  SceneProfile,
  StepConversionRequest,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { AuthProvider } from "@/lib/auth";
import {
  cutsToRanges,
  frameToSeconds,
  frameToTimecode,
  parseRational,
} from "@/lib/frames";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import downloadsFixture from "../../../fixtures/downloads_succeeded.json";
import projectFixture from "../../../fixtures/project.json";
import sceneProfileFixture from "../../../fixtures/scene_profile.json";

import { DepthPanel } from "./DepthPanel";
import {
  SHOT_TYPE_LABELS,
  STEREO_PROFILE_KIND,
  type StereoProfileFile,
} from "./stereoProfile";
import { loadStereoDraft, saveStereoDraft, stereoDraftKey } from "./stereoStore";
import { StereoPanel } from "./StereoPanel";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 50, PROFILE_POLL_MS: 50 }));

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
const PROFILE = (sceneProfileFixture as { scene_profile: unknown })
  .scene_profile as SceneProfile;
const FPS = parseRational(FIXTURE.probe!.fps_rational);
const CUTS = FIXTURE.scenes!.cuts;
const N = FIXTURE.probe!.num_frames;
const VERSION = FIXTURE.scenes!.version;
const FIRST_CUT = CUTS[0];

function fixtureProject(overrides: Partial<Project> = {}): Project {
  return {
    ...(structuredClone(projectFixture) as unknown as Project),
    ...overrides,
  };
}

function withProfile(scenesVersion = VERSION): Project {
  const p = fixtureProject();
  p.scene_profile = {
    ...(structuredClone(PROFILE) as SceneProfile),
    scenes_version: scenesVersion,
  };
  return p;
}

function renderPanel(project: Project = fixtureProject()) {
  const onProjectChanged = vi.fn();
  const view = render(
    <AuthProvider>
      <StereoPanel project={project} onProjectChanged={onProjectChanged} />
    </AuthProvider>,
  );
  return { onProjectChanged, view };
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

function sceneRow(start: number): HTMLElement {
  return screen.getByTestId(`stereo-scene-${start}`);
}

/** A succeeded stereo run seeded into BOTH the mock db (so /downloads
 * works) and the returned conversion (for project.conversions). */
function seededStereoRun(
  projectId: string,
  overrides: Partial<Conversion> = {},
): Conversion {
  const conv: Conversion = {
    conversion_id: "priorstereo01",
    state: "succeeded",
    kind: "video",
    project_id: projectId,
    step: "stereo_preview",
    params: {
      preset: "draft",
      formats: ["sbs"],
      inpaint: "none",
      target_fps: 12,
    },
    quote: { amount_cents: 63, currency: "usd" },
    progress: 1,
    outputs: ["sbs"],
    created_at: "2026-07-02T08:00:00Z",
    updated_at: "2026-07-02T08:05:00Z",
    ...overrides,
  };
  mockDb.conversions.set(conv.conversion_id, structuredClone(conv));
  return conv;
}

describe("StereoPanel scene rows", () => {
  it("tiles the timeline: one row per scene with frame range + timecode", () => {
    renderPanel();

    const rows = screen.getAllByTestId(/^stereo-scene-/);
    expect(rows).toHaveLength(CUTS.length + 1);

    // first scene [0, FIRST_CUT), labeled with frames.ts timecode
    const first = sceneRow(0);
    expect(first.textContent).toContain("Scene 1");
    expect(first.textContent).toContain(`f0–f${FIRST_CUT}`);
    expect(first.textContent).toContain(frameToTimecode(0, FPS));

    // last scene ends at num_frames (half-open tiling)
    const last = sceneRow(CUTS[CUTS.length - 1]);
    expect(last.textContent).toContain(`f${CUTS[CUTS.length - 1]}–f${N}`);
  });

  it("seeds Auto defaults from a fresh scene_profile (user-facing shot-type label, no raw enum)", () => {
    renderPanel(withProfile());

    expect(screen.queryByTestId("stale-profile-warning")).toBeNull();
    expect(screen.queryByTestId("adaptive-note")).toBeNull();

    const shot0 = PROFILE.shots.find((s) => s.first_src === 0)!;
    const select = within(sceneRow(0)).getByLabelText(
      "Scene 1 shot type",
    ) as HTMLSelectElement;
    expect(select.value).toBe("auto");
    expect(select.selectedOptions[0].textContent).toBe(
      `Auto (${SHOT_TYPE_LABELS[shot0.shot_type]})`,
    );
    // the numeric displacement input is deliberately gone this release
    expect(
      within(sceneRow(0)).queryByLabelText("Scene 1 displacement"),
    ).toBeNull();
    // options show the friendly names, never the snake_case wire values
    expect([...select.options].map((o) => o.textContent)).toEqual([
      `Auto (${SHOT_TYPE_LABELS[shot0.shot_type]})`,
      "Close-up",
      "Standard",
      "Dynamic",
      "Wide",
    ]);
  });

  it("warns when the profile was computed against older scene cuts", () => {
    renderPanel(withProfile(VERSION - 1));
    expect(
      screen.getByTestId("stale-profile-warning").textContent,
    ).toContain("Scene cuts changed since this profile was computed");
  });

  it("explains the adaptive first run when no profile exists yet", () => {
    renderPanel(); // fixture has no scene_profile
    expect(screen.getByTestId("adaptive-note").textContent).toMatch(
      /computes per-scene depth parameters automatically/i,
    );
    // rows still render, with bare Auto defaults
    const select = within(sceneRow(0)).getByLabelText(
      "Scene 1 shot type",
    ) as HTMLSelectElement;
    expect(select.selectedOptions[0].textContent).toBe("Auto");
  });
});

describe("StereoPanel request building", () => {
  it("Edge handling maps to the wire pair: stretched = backward+none, fast = migan, best = propainter (no model names in copy)", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel(withProfile());

    const select = screen.getByLabelText("Edge handling") as HTMLSelectElement;
    // user-facing names only — never the renderer terms
    expect(select.value).toBe("best");
    expect(select.selectedOptions[0].textContent).toBe("Filled edges — best");
    expect(screen.queryByText(/backward|gather|splat|propainter|migan/i)).toBeNull();

    await user.selectOptions(select, "stretched");
    expect(select.selectedOptions[0].textContent).toBe("Stretched edges");
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      step: "stereo_preview",
      warp: "backward",
      inpaint: "none", // a gather warp has no gaps to fill
    });

    // fast fill: forward warp (no warp field) + migan
    await user.selectOptions(select, "fast");
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).not.toHaveProperty("warp");
    expect(bodies[1]).toMatchObject({ inpaint: "migan" });

    // back to the default: warp absent, full-quality fill restored
    await user.selectOptions(select, "best");
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]).not.toHaveProperty("warp");
    expect(bodies[2]).toMatchObject({ inpaint: "propainter" });
  });

  it("sends ONLY user-changed rows as scene_overrides — auto rows and top-level displacement are ABSENT", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel(withProfile());

    // scene 1 and scene 2 (starts at the first cut) get shot_type
    // overrides; every other row stays auto
    await user.selectOptions(
      within(sceneRow(0)).getByLabelText("Scene 1 shot type"),
      "close_up",
    );
    await user.selectOptions(
      within(sceneRow(FIRST_CUT)).getByLabelText("Scene 2 shot type"),
      "wide",
    );
    // both rows show the overridden chip; scene 3 does not
    expect(screen.getByTestId(`override-chip-0`)).toBeDefined();
    expect(screen.getByTestId(`override-chip-${FIRST_CUT}`)).toBeDefined();
    expect(screen.queryByTestId(`override-chip-${CUTS[1]}`)).toBeNull();

    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      step: "stereo_preview",
      preset: "1080p",
      formats: ["sbs"],
      inpaint: "propainter",
      scene_overrides: [
        { first: 0, shot_type: "close_up" },
        { first: FIRST_CUT, shot_type: "wide" },
      ],
      target_fps: 24,
      platform: "web",
    });
  });

  it("a draft displacement (e.g. imported) still reaches the wire without a UI input", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    saveStereoDraft(FIXTURE.project_id, VERSION, {
      overrides: { "0": { displacement: 0.02 } },
      depth_scale: 1,
    });
    renderPanel();

    expect(screen.getByTestId("override-chip-0")).toBeDefined();
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].scene_overrides).toEqual([
      { first: 0, displacement: 0.02 },
    ]);
  });

  it("a per-row Reset returns the scene to auto (and drops it from the request)", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();

    await user.selectOptions(
      within(sceneRow(0)).getByLabelText("Scene 1 shot type"),
      "wide",
    );
    expect(screen.getByTestId("override-chip-0")).toBeDefined();
    await user.click(screen.getByLabelText("Reset scene 1 to auto"));
    expect(screen.queryByTestId("override-chip-0")).toBeNull();

    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].scene_overrides).toBeUndefined();
  });

  it("includes depth_scale only when the master slider moved off 1.0", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByTestId("depth-scale-value").textContent).toBe("×1.00");
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].depth_scale).toBeUndefined();

    // Radix slider thumb responds to keyboard: one ArrowRight = +step (0.05)
    const thumb = screen.getByRole("slider");
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(screen.getByTestId("depth-scale-value").textContent).toBe("×1.05");
    expect(screen.queryByTestId("quote-breakdown")).toBeNull(); // invalidated

    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].depth_scale).toBeCloseTo(1.05, 5);
  });

  it("offers the SAME formats Deliver sells — MV-HEVC included, no TB — sbs default, and sends the picked set", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();

    const formats = screen.getByRole("group", { name: "Formats" });
    const boxes = within(formats).getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    for (const name of ["SBS", "Half-SBS", "Anaglyph", "MV-HEVC"]) {
      expect(within(formats).getByRole("checkbox", { name })).toBeDefined();
    }
    expect(
      (within(formats).getByRole("checkbox", { name: "SBS" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(within(formats).queryByRole("checkbox", { name: "TB" })).toBeNull();

    await user.click(within(formats).getByRole("checkbox", { name: "MV-HEVC" }));
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].formats).toEqual(["sbs", "mvhevc"]);
  });

  it("blocks checkout while every format is deselected", async () => {
    const user = userEvent.setup();
    renderPanel();

    const formats = screen.getByRole("group", { name: "Formats" });
    await user.click(within(formats).getByRole("checkbox", { name: "SBS" })); // sole default off

    const quoteBtn = screen.getByRole("button", { name: "Get quote" }) as HTMLButtonElement;
    expect(quoteBtn.disabled).toBe(true);
    expect(screen.getByText("Select at least one format")).toBeDefined();

    // re-selecting any format unblocks
    await user.click(within(formats).getByRole("checkbox", { name: "Half-SBS" }));
    expect(quoteBtn.disabled).toBe(false);
    expect(screen.queryByText("Select at least one format")).toBeNull();
  });

  it("offers the SAME resolution presets as Deliver (1080p default) and sends the pick on the wire", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();

    const preset = document.getElementById("stereo-preset") as HTMLSelectElement;
    expect([...preset.options].map((o) => o.value)).toEqual([
      "1080p",
      "qhd",
      "3k",
      "4k",
    ]);
    expect(preset.value).toBe("1080p");

    await user.selectOptions(preset, "4k");
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].preset).toBe("4k");
  });
});

describe("StereoPanel quote pricing", () => {
  it("every run is full quality (×1.6 on the quote) — there is no mode choice and no model name in the copy", async () => {
    const user = userEvent.setup();
    renderPanel();

    // the cheap opt-out is deliberately not exposed this release
    expect(screen.queryByRole("radio")).toBeNull();
    expect(document.body.textContent).not.toMatch(/ProPainter|[Ss]platted/);

    await getQuote(user);
    // 149.46 s at 120¢ cost × 3 margin full rate → 897¢ base; the letterboxed 2.39:1
    // fixture prices the default 980 depth at ×1.345 on the 0.35 share →
    // 1005¢; ×1.6 propainter = 1608¢ → −161 bulk = $14.47 (no analyze credit)
    expect(screen.getByTestId("quote-base").textContent).toBe("$8.97");
    expect(screen.getByTestId("quote-inpaint-multiplier").textContent).toBe("×1.6");
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$16.08");
    expect(screen.getByTestId("quote-total").textContent).toBe("$14.47");
    // the breakdown line explains the multiplier without internal terms
    expect(screen.getByTestId("quote-breakdown").textContent).toContain(
      "Edge handling",
    );
  });

  it("surfaces the gateway's scene_overrides validation errors", async () => {
    const user = userEvent.setup();
    // 0.05 is outside (0, 0.03]; only a hand-edited draft/import can carry
    // it now that the numeric input is gone — the gateway still rejects it
    saveStereoDraft(FIXTURE.project_id, VERSION, {
      overrides: { "0": { displacement: 0.05 } },
      depth_scale: 1,
    });
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Get quote" }));
    expect(
      await screen.findByText(
        "scene_overrides[].displacement must be in (0, 0.03]",
      ),
    ).toBeDefined();
    expect(screen.queryByTestId("quote-breakdown")).toBeNull();
  });
});

describe("StereoPanel output follower (one transport)", () => {
  /** Render with a seeded succeeded run and wait for the follower video. */
  async function renderWithOutput(project = fixtureProject()) {
    project.conversions = [seededStereoRun(project.project_id)];
    renderPanel(project);
    const output = (await screen.findByTestId(
      "stereo-output-video",
    )) as HTMLVideoElement;
    const master = screen.getByTestId("preview-video") as HTMLVideoElement;
    return { project, master, output };
  }

  it("renders the last succeeded run's SBS output BESIDE the main preview — no second transport", async () => {
    const { project, master, output } = await renderWithOutput();
    expect(master.getAttribute("src")).toBe(project.preview_url);
    expect(output.getAttribute("src")).toBe(
      (downloadsFixture.downloads as Record<string, string>).sbs,
    );
    expect(screen.getByTestId("stereo-output-video-badge").textContent).toBe("sbs");

    // ONE transport: the main preview's. No compare-specific controls left.
    expect(screen.getByLabelText("Play preview")).toBeDefined();
    expect(screen.queryByLabelText("Scene to play")).toBeNull();
    expect(screen.getAllByLabelText("Speed")).toHaveLength(1);
    // and the Cut-style timeline is there for scrubbing
    expect(screen.getByTestId("filmstrip")).toBeDefined();
    // active-picture (crop) overlay on the preview, same as Media/Cut
    expect(screen.getByTestId("crop-overlay")).toBeDefined();
  });

  it("prefers sbs → half_sbs → anaglyph when picking the playable output", async () => {
    const project = fixtureProject();
    project.conversions = [
      seededStereoRun(project.project_id, {
        params: { preset: "draft", formats: ["half_sbs", "anaglyph"] },
        outputs: ["anaglyph", "half_sbs"],
      }),
    ];
    renderPanel(project);

    const video = (await screen.findByTestId(
      "stereo-output-video",
    )) as HTMLVideoElement;
    expect(video.getAttribute("src")).toContain("half_sbs");
    expect(screen.getByTestId("stereo-output-video-badge").textContent).toBe(
      "half_sbs",
    );
  });

  it("the MAIN transport drives the output too: Play/Pause mirror, position syncs by FRACTION of duration", async () => {
    const { master, output } = await renderWithOutput();

    const playSpy = vi.spyOn(output, "play");
    fireEvent.click(screen.getByLabelText("Play preview"));
    expect(playSpy).toHaveBeenCalledTimes(1); // master play event → follower

    Object.defineProperty(master, "duration", { value: 100, configurable: true });
    Object.defineProperty(output, "duration", { value: 50, configurable: true });
    master.currentTime = 40;
    fireEvent.timeUpdate(master);
    expect(output.currentTime).toBeCloseTo(20, 5);

    const pauseSpy = vi.spyOn(output, "pause");
    fireEvent.click(screen.getByLabelText("Pause preview"));
    expect(pauseSpy).toHaveBeenCalled();
  });

  it("clicking a scene row seeks the MAIN preview (and the follower via seeked) to the scene's first frame", async () => {
    const { master, output } = await renderWithOutput();
    const RANGES2 = cutsToRanges(CUTS, N);
    const [first] = RANGES2[2];

    for (const v of [master, output]) {
      Object.defineProperty(v, "duration", {
        value: FIXTURE.probe!.duration_s,
        configurable: true,
      });
    }

    fireEvent.click(
      within(sceneRow(first)).getByTestId("scene-card"),
    );
    // frame-exact master seek: mid-frame time of the scene's first frame
    expect(master.currentTime).toBeGreaterThan(frameToSeconds(first, FPS));
    expect(sceneRow(first).getAttribute("class")).toContain("border-primary");
    expect(screen.getByTestId("frame-readout").textContent).toContain(`f${first}`);

    // the browser answers the seek with 'seeked' — the follower tracks it
    fireEvent.seeked(master);
    expect(output.currentTime).toBeCloseTo(master.currentTime, 5);
  });

  it("badges the output and reveals its decoded size once metadata lands; the follower STAYS muted when the master unmutes", async () => {
    const { master, output } = await renderWithOutput();

    Object.defineProperty(output, "videoWidth", { value: 1920, configurable: true });
    Object.defineProperty(output, "videoHeight", { value: 540, configurable: true });
    fireEvent(output, new Event("loadedmetadata"));
    expect(screen.getByTestId("stereo-output-video-badge").textContent).toBe(
      "sbs 1920×540",
    );

    expect(master.muted).toBe(true);
    expect(output.muted).toBe(true);
    fireEvent.click(screen.getByLabelText("Unmute"));
    expect(master.muted).toBe(false); // the source proxy carries the audio
    expect(output.muted).toBe(true); // the follower must never double-play
  });

  it("the Speed select mirrors onto the output via ratechange", async () => {
    const { master, output } = await renderWithOutput();
    const speed = screen.getByLabelText("Speed") as HTMLSelectElement;
    await userEvent.setup().selectOptions(speed, "1.5");
    expect(master.playbackRate).toBe(1.5);
    // jsdom doesn't dispatch ratechange on assignment — fire it like a browser
    fireEvent(master, new Event("ratechange"));
    expect(output.playbackRate).toBe(1.5);
  });
});

describe("StereoPanel draft persistence", () => {
  it("persists row overrides + depth_scale to the versioned localStorage key and restores on remount", async () => {
    const user = userEvent.setup();
    const { view } = renderPanel();

    await user.selectOptions(
      within(sceneRow(0)).getByLabelText("Scene 1 shot type"),
      "wide",
    );
    await user.selectOptions(
      within(sceneRow(FIRST_CUT)).getByLabelText("Scene 2 shot type"),
      "close_up",
    );
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });

    const key = stereoDraftKey(FIXTURE.project_id, VERSION);
    await waitFor(() => {
      const draft = loadStereoDraft(FIXTURE.project_id, VERSION);
      expect(draft.overrides["0"]).toEqual({ shot_type: "wide" });
      expect(draft.overrides[String(FIRST_CUT)]).toEqual({ shot_type: "close_up" });
      expect(draft.depth_scale).toBeCloseTo(1.05, 5);
    });
    expect(window.localStorage.getItem(key)).not.toBeNull();

    // tab switch = unmount/remount — the draft survives
    view.unmount();
    renderPanel();
    expect(
      (within(sceneRow(0)).getByLabelText("Scene 1 shot type") as HTMLSelectElement)
        .value,
    ).toBe("wide");
    expect(
      (within(sceneRow(FIRST_CUT)).getByLabelText("Scene 2 shot type") as HTMLSelectElement)
        .value,
    ).toBe("close_up");
    expect(screen.getByTestId("depth-scale-value").textContent).toBe("×1.05");
    expect(screen.getByTestId("override-chip-0")).toBeDefined();
  });
});

describe("StereoPanel 2D passthrough", () => {
  function toggle(start: number, n: number) {
    return within(sceneRow(start)).getByLabelText(
      `Scene ${n} convert to 3D`,
    ) as HTMLInputElement;
  }

  it("defaults every scene to Convert-to-3D checked", () => {
    renderPanel();
    expect(toggle(0, 1).checked).toBe(true);
    expect(toggle(FIRST_CUT, 2).checked).toBe(true);
  });

  it("unchecking disables the row's depth controls, mutes the row, and emits EXACTLY {first, passthrough: true} — the stashed depth tweak stays OFF the wire", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    // stash a depth tweak first (draft-seeded — no numeric input anymore):
    // it must survive in the DRAFT but be dropped from the request while
    // passthrough is on
    saveStereoDraft(FIXTURE.project_id, VERSION, {
      overrides: { "0": { displacement: 0.02 } },
      depth_scale: 1,
    });
    renderPanel();

    await user.click(toggle(0, 1));

    const shot = within(sceneRow(0)).getByLabelText(
      "Scene 1 shot type",
    ) as HTMLSelectElement;
    expect(shot.disabled).toBe(true);
    expect(sceneRow(0).className).toContain("opacity-60");
    expect(screen.getByTestId("passthrough-note-0").textContent).toBe(
      "2D passthrough — shipped as-is (both eyes identical)",
    );
    // the draft stashes BOTH (passthrough + the depth tweak)
    expect(loadStereoDraft(FIXTURE.project_id, VERSION).overrides["0"]).toEqual({
      displacement: 0.02,
      passthrough: true,
    });

    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].scene_overrides).toEqual([{ first: 0, passthrough: true }]);
  });

  it("toggling back to 3D re-enables the controls and restores the draft's depth values on the wire", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    saveStereoDraft(FIXTURE.project_id, VERSION, {
      overrides: { "0": { displacement: 0.02 } },
      depth_scale: 1,
    });
    renderPanel();

    await user.click(toggle(0, 1)); // off → passthrough
    await user.click(toggle(0, 1)); // back on

    const shot = within(sceneRow(0)).getByLabelText(
      "Scene 1 shot type",
    ) as HTMLSelectElement;
    expect(shot.disabled).toBe(false);
    expect(screen.queryByTestId("passthrough-note-0")).toBeNull();

    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].scene_overrides).toEqual([{ first: 0, displacement: 0.02 }]);
  });

  it("a passthrough set on the DEPTH page appears here — same store", async () => {
    const user = userEvent.setup();
    const view = render(
      <AuthProvider>
        <DepthPanel project={fixtureProject()} onProjectChanged={vi.fn()} />
      </AuthProvider>,
    );
    await user.click(
      within(screen.getByTestId("depth-scenes")).getByLabelText(
        "Scene 1 convert to 3D",
      ),
    );
    expect(loadStereoDraft(FIXTURE.project_id, VERSION).overrides["0"]).toEqual({
      passthrough: true,
    });
    view.unmount();

    renderPanel();
    expect(toggle(0, 1).checked).toBe(false);
    expect(
      (within(sceneRow(0)).getByLabelText("Scene 1 shot type") as HTMLSelectElement)
        .disabled,
    ).toBe(true);
    expect(toggle(FIRST_CUT, 2).checked).toBe(true); // only scene 1 flagged
  });
});

/** A succeeded depth run seeded into BOTH the mock db (so /downloads and
 * the reuse lookup work) and the returned conversion. target_fps matches
 * the panel's explicit full-rate request so the depth artifact key aligns. */
function seededDepthRun(
  projectId: string,
  overrides: Partial<Conversion> = {},
): Conversion {
  const conv: Conversion = {
    conversion_id: "priordepth001",
    state: "succeeded",
    kind: "video",
    project_id: projectId,
    step: "depth_preview",
    params: {
      preset: "draft",
      formats: ["anaglyph"],
      inpaint: "none",
      depth_res: 980,
      target_fps: 24,
    },
    quote: { amount_cents: 50, currency: "usd" },
    progress: 1,
    outputs: ["anaglyph", "depth", "depth_vis"],
    created_at: "2026-07-01T08:00:00Z",
    updated_at: "2026-07-01T08:05:00Z",
    ...overrides,
  };
  mockDb.conversions.set(conv.conversion_id, structuredClone(conv));
  return conv;
}

describe("StereoPanel depth inheritance & reuse", () => {
  it("sends the Depth run's depth_res and the quote discounts the reused depth stage", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    renderPanel(project);

    expect(screen.getByTestId("stereo-chip-depth").textContent).toContain(
      "Depth map 980 px",
    );

    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].depth_res).toBe(980);
    // subtotal 1608¢ (propainter default); depth share 0.35 reused →
    // −563¢ = 1045¢ → −105 bulk = $9.40 (no analyze credit)
    expect(screen.getByTestId("quote-reuse-stages").textContent).toBe("depth");
    expect(screen.getByTestId("quote-reuse-discount").textContent).toBe(
      "−$5.63",
    );
    expect(screen.getByTestId("quote-total").textContent).toBe("$9.40");
  });

  it("the “use pipeline default” escape drops depth_res (and the discount) from the request", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    const project = fixtureProject();
    // 1442 ≠ the 1080p preset default (980), so dropping the inheritance
    // genuinely misses the depth artifact key — no reuse discount
    project.conversions = [
      seededDepthRun(project.project_id, {
        params: {
          preset: "draft",
          formats: ["anaglyph"],
          inpaint: "none",
          depth_res: 1442,
          target_fps: 24,
        },
      }),
    ];
    renderPanel(project);

    await user.click(
      screen.getByRole("checkbox", {
        name: "Use pipeline default depth resolution",
      }),
    );
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].depth_res).toBeUndefined();
    expect(screen.queryByTestId("quote-reuse-stages")).toBeNull();
  });

  it("shows a picker when several depth resolutions exist and sends the picked one", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    const project = fixtureProject();
    const run980 = seededDepthRun(project.project_id);
    const run1442 = seededDepthRun(project.project_id, {
      conversion_id: "priordepth002",
      params: {
        preset: "draft",
        formats: ["anaglyph"],
        inpaint: "none",
        depth_res: 1442,
        target_fps: 24,
      },
      created_at: "2026-07-02T09:00:00Z",
    });
    project.conversions = [run980, run1442];
    renderPanel(project);

    // newest run's resolution is preselected; both are offered
    const picker = screen.getByLabelText(
      "Depth map to reuse",
    ) as HTMLSelectElement;
    expect(picker.value).toBe(run1442.conversion_id);
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      expect.stringContaining("1442 px"),
      expect.stringContaining("980 px"),
    ]);
    expect(screen.queryByTestId("stereo-chip-depth")).toBeNull();

    await user.selectOptions(picker, run980.conversion_id);
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].depth_res).toBe(980);
    expect(screen.getByTestId("quote-reuse-stages").textContent).toBe("depth");
  });

  it("explains itself when no depth run exists yet", () => {
    renderPanel();
    expect(screen.getByTestId("stereo-chip-depth-none").textContent).toContain(
      "No depth run yet",
    );
  });

  /** Register an uploaded depth map on BOTH the prop project and the mock
   * db (quotes validate against the db's copy). */
  function withUpload(project: Project): Project {
    project.depth_upload = {
      name: "graded-depth.mp4",
      frames: FIXTURE.probe!.num_frames,
      width: FIXTURE.probe!.width,
      height: FIXTURE.probe!.height,
      bytes: 1 << 20,
      created_at: "2026-07-03T08:00:00Z",
    };
    mockDb.projects.get(FIXTURE.project_id)!.depth_upload =
      project.depth_upload;
    return project;
  }

  it("an uploaded depth map (no runs) sends use_uploaded_depth — no depth_res, no target_fps, depth share discounted", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel(withUpload(fixtureProject()));

    expect(
      screen.getByTestId("stereo-chip-depth-upload").textContent,
    ).toContain("graded-depth.mp4");

    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].use_uploaded_depth).toBe(true);
    expect(bodies[0].depth_res).toBeUndefined();
    // the gateway pins uploaded-depth runs to the full source rate itself
    expect(bodies[0].target_fps).toBeUndefined();
    expect(screen.getByTestId("quote-reuse-stages").textContent).toBe("depth");
  });

  it("the picker lists depth runs AND the upload; picking the upload switches the request", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    const project = withUpload(fixtureProject());
    project.conversions = [seededDepthRun(project.project_id)];
    renderPanel(project);

    // newest RUN stays the default; the upload is one choice among them
    const picker = screen.getByLabelText(
      "Depth map to reuse",
    ) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      expect.stringContaining("980 px"),
      expect.stringContaining("Uploaded — graded-depth.mp4"),
    ]);

    await user.selectOptions(picker, "__uploaded_depth__");
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].use_uploaded_depth).toBe(true);
    expect(bodies[0].depth_res).toBeUndefined();
  });
});

describe("StereoPanel depth-map compare slot", () => {
  it("shows the Depth run's depth map beside the source when no stereo output exists yet", async () => {
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    renderPanel(project);

    const depth = (await screen.findByTestId(
      "stereo-depth-video",
    )) as HTMLVideoElement;
    expect(depth.getAttribute("src")).toBe(
      (downloadsFixture.downloads as Record<string, string>).depth_vis,
    );
    expect(screen.getByTestId("stereo-depth-video-badge").textContent).toBe(
      "depth map",
    );
    // no toggle without an output — just the explanatory note
    expect(screen.queryByTestId("stereo-compare-toggle")).toBeNull();
  });

  it("offers a toggle between the 3D output (default) and the depth map when both exist", async () => {
    const user = userEvent.setup();
    const project = fixtureProject();
    project.conversions = [
      seededDepthRun(project.project_id),
      seededStereoRun(project.project_id),
    ];
    renderPanel(project);

    // output leads
    await screen.findByTestId("stereo-output-video");
    const toggleGroup = screen.getByTestId("stereo-compare-toggle");
    expect(screen.queryByTestId("stereo-depth-video")).toBeNull();

    await user.click(within(toggleGroup).getByRole("button", { name: "Depth map" }));
    await screen.findByTestId("stereo-depth-video");
    expect(screen.queryByTestId("stereo-output-video")).toBeNull();

    await user.click(within(toggleGroup).getByRole("button", { name: "3D output" }));
    await screen.findByTestId("stereo-output-video");
  });
});

describe("StereoPanel scene-profile import/export", () => {
  it("Export profile downloads the scene table (Auto values + draft tweaks + depth_scale) as JSON named after the project", async () => {
    saveStereoDraft(FIXTURE.project_id, VERSION, {
      overrides: { "0": { displacement: 0.02 } },
      depth_scale: 1.1,
    });
    renderPanel(withProfile());

    // jsdom has no Blob URLs — stub the pair and capture the payload
    let blob: Blob | null = null;
    const createObjectURL = vi.fn((b: Blob) => {
      blob = b;
      return "blob:mock";
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    let download = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        download = this.download;
      },
    );

    fireEvent.click(screen.getByText("Export profile"));

    expect(download).toBe(`${FIXTURE.name}-stereo-profile.json`);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    const doc = JSON.parse(await blob!.text()) as StereoProfileFile;
    expect(doc.kind).toBe(STEREO_PROFILE_KIND);
    expect(doc.scenes_version).toBe(VERSION);
    expect(doc.depth_scale).toBe(1.1);
    expect(doc.scenes).toHaveLength(CUTS.length + 1);
    const shot0 = PROFILE.shots.find((s) => s.first_src === 0)!;
    expect(doc.scenes[0]).toMatchObject({
      scene: 1,
      first: 0,
      timecode: frameToTimecode(0, FPS),
      auto: {
        shot_type: shot0.shot_type,
        displacement: shot0.displacement,
      },
      override: { displacement: 0.02 },
    });
  });

  it("Import profile… replaces the draft only after the explicit confirm, and the values reach the wire", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();

    const file = new File(
      [
        JSON.stringify({
          kind: STEREO_PROFILE_KIND,
          scenes_version: VERSION,
          depth_scale: 1.2,
          scenes: [
            { first: 0, override: { displacement: 0.015 } },
            { first: FIRST_CUT, override: { shot_type: "wide" } },
          ],
        }),
      ],
      "profile.json",
      { type: "application/json" },
    );
    fireEvent.change(screen.getByLabelText("Scene profile file"), {
      target: { files: [file] },
    });

    // confirm dialog summarizes the replacement; nothing changed yet
    const dialog = await screen.findByTestId("import-profile-dialog");
    expect(dialog.textContent).toContain("2 imported overrides");
    expect(dialog.textContent).toContain("×1.20");
    expect(screen.queryByTestId("override-chip-0")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(screen.queryByTestId("import-profile-dialog")).toBeNull(),
    );

    // rows and the master slider show the imported draft, and it persisted
    // (the displacement override has no input anymore — the chip marks it)
    expect(screen.getByTestId("override-chip-0")).toBeDefined();
    expect(
      (within(sceneRow(FIRST_CUT)).getByLabelText("Scene 2 shot type") as HTMLSelectElement)
        .value,
    ).toBe("wide");
    expect(screen.getByTestId("depth-scale-value").textContent).toBe("×1.20");
    await waitFor(() =>
      expect(loadStereoDraft(FIXTURE.project_id, VERSION).depth_scale).toBeCloseTo(
        1.2,
        5,
      ),
    );

    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].depth_scale).toBeCloseTo(1.2, 5);
    expect(bodies[0].scene_overrides).toEqual([
      { first: 0, displacement: 0.015 },
      { first: FIRST_CUT, shot_type: "wide" },
    ]);
  });

  it("surfaces parse/validation errors inline and leaves the draft untouched", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.selectOptions(
      within(sceneRow(0)).getByLabelText("Scene 1 shot type"),
      "wide",
    );

    const file = new File(
      [
        JSON.stringify({
          kind: STEREO_PROFILE_KIND,
          scenes_version: VERSION - 1,
          scenes: [{ first: 1, override: { displacement: 0.01 } }],
        }),
      ],
      "profile.json",
      { type: "application/json" },
    );
    fireEvent.change(screen.getByLabelText("Scene profile file"), {
      target: { files: [file] },
    });

    const note = await screen.findByTestId("profile-import-error");
    expect(note.textContent).toContain(
      "frame 1 does not start a scene on the current cut list",
    );
    expect(note.textContent).toContain(`v${VERSION - 1}`);
    expect(screen.queryByTestId("import-profile-dialog")).toBeNull();
    // the existing tweak survived
    expect(
      (within(sceneRow(0)).getByLabelText("Scene 1 shot type") as HTMLSelectElement)
        .value,
    ).toBe("wide");
  });
});

describe("StereoPanel free shot profiling", () => {
  /** Minimal stand-in for the workspace: holds the project in state and
   * refetches it from the mock gateway on onProjectChanged — each GET
   * advances the mock's profile lifecycle one step. */
  function ProfileHarness({ initial }: { initial: Project }) {
    const client = useGateway();
    const [project, setProject] = useState(initial);
    return (
      <StereoPanel
        project={project}
        onProjectChanged={() => {
          void client.getProject(initial.project_id).then(setProject);
        }}
      />
    );
  }

  const EXPLANATION =
    /Measures each scene.s depth and seeds these controls — free/;

  it("offers the free profile action when no scene_profile exists, and when it is STALE — not when fresh", () => {
    renderPanel(); // fixture has no scene_profile
    expect(screen.getByRole("button", { name: "Profile shots (free)" })).toBeDefined();
    expect(screen.getByText(EXPLANATION)).toBeDefined();
    cleanup();

    renderPanel(withProfile(VERSION - 1)); // stale → offer again
    expect(screen.getByRole("button", { name: "Profile shots (free)" })).toBeDefined();
    cleanup();

    renderPanel(withProfile()); // fresh → nothing to profile
    expect(screen.queryByTestId("profile-action")).toBeNull();
  });

  it("click → running progress (stage + percent) → completion seeds the rows from the new scene_profile", async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <ProfileHarness initial={fixtureProject()} />
      </AuthProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Profile shots (free)" }));

    // POST set profile running; the panel's refetch (project GET #1)
    // advances the mock's progress
    const running = await screen.findByTestId("profile-running");
    expect(running.textContent).toContain("Profiling shots");
    expect(running.textContent).toContain("60%");
    expect(screen.queryByRole("button", { name: "Profile shots (free)" })).toBeNull();

    // the 50 ms poll issues project GET #2 → succeeded + scene_profile
    await waitFor(() => expect(screen.queryByTestId("profile-running")).toBeNull());

    // rows re-seeded from the profiled shots (mock bucket 0 = standard) —
    // and the action is gone (profile now fresh)
    const shot = within(sceneRow(0)).getByLabelText(
      "Scene 1 shot type",
    ) as HTMLSelectElement;
    expect(shot.selectedOptions[0].textContent).toBe("Auto (Standard)");
    expect(screen.queryByTestId("profile-action")).toBeNull();
    expect(screen.queryByTestId("stale-profile-warning")).toBeNull();

    // and the mock stamped the project like the gateway would
    const project = mockDb.projects.get(FIXTURE.project_id)!;
    expect(project.profile?.state).toBe("succeeded");
    expect(project.scene_profile?.conversion_id).toMatch(/^profile:/);
    expect(project.scene_profile?.scenes_version).toBe(VERSION);
  });

  it("a failed profile shows its error inline with a Retry", () => {
    const p = fixtureProject();
    p.profile = {
      state: "failed",
      scenes_version: VERSION,
      error: "profiler ran out of GPU memory",
      updated_at: "2026-07-02T08:00:00Z",
    };
    renderPanel(p);
    expect(screen.getByTestId("profile-error").textContent).toContain(
      "profiler ran out of GPU memory",
    );
    expect(
      screen.getByRole("button", { name: "Retry profiling (free)" }),
    ).toBeDefined();
  });

  it("surfaces the gateway's 409 when a profile is already running", async () => {
    const user = userEvent.setup();
    mockDb.projects.get(FIXTURE.project_id)!.profile = {
      state: "running",
      scenes_version: VERSION,
      progress: 0.1,
      stage: "profiling",
      updated_at: "2026-07-02T08:00:00Z",
    };
    renderPanel(); // the PROP project has no profile → button still offered
    await user.click(screen.getByRole("button", { name: "Profile shots (free)" }));
    expect(
      (await screen.findByTestId("profile-error")).textContent,
    ).toContain("a profiling job is already running");
  });
});
