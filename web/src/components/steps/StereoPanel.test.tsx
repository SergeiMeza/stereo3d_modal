/**
 * Stereo page tests: per-scene rows derived from the fixture's REAL cuts
 * (frame ranges + timecodes via frames.ts, never hardcoded), scene_profile
 * seeding + the stale-profile warning, ONLY-changed-rows scene_overrides on
 * the wire (displacement top-level ABSENT), the Deliver-parity output params
 * (resolution preset + MV-HEVC format + inpainted DEFAULT, ×1.6 by default),
 * the ONE-transport review area (the latest output as a follower of the main
 * preview), row-click seeking + active-row highlight, localStorage draft
 * persistence (the store Deliver inherits), per-scene 2D passthrough
 * (exactly {first, passthrough:true} on the wire; draft depth values stashed
 * and restored), and the free shot-profiling action.
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
import { loadStereoDraft, stereoDraftKey } from "./stereoStore";
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

  it("seeds Auto defaults from a fresh scene_profile (shot_type + displacement placeholder)", () => {
    renderPanel(withProfile());

    expect(screen.queryByTestId("stale-profile-warning")).toBeNull();
    expect(screen.queryByTestId("adaptive-note")).toBeNull();

    const shot0 = PROFILE.shots.find((s) => s.first_src === 0)!;
    const select = within(sceneRow(0)).getByLabelText(
      "Scene 1 shot type",
    ) as HTMLSelectElement;
    expect(select.value).toBe("auto");
    expect(select.selectedOptions[0].textContent).toBe(
      `Auto (${shot0.shot_type})`,
    );
    const disp = within(sceneRow(0)).getByLabelText(
      "Scene 1 displacement",
    ) as HTMLInputElement;
    expect(disp.value).toBe(""); // auto — nothing sent
    expect(disp.placeholder).toBe(shot0.displacement.toFixed(4));
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
  it("sends ONLY user-changed rows as scene_overrides — auto rows and top-level displacement are ABSENT", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel(withProfile());

    // scene 1: explicit displacement; scene 2 (starts at the first cut):
    // shot_type override; every other row stays auto
    const disp = within(sceneRow(0)).getByLabelText("Scene 1 displacement");
    fireEvent.change(disp, { target: { value: "0.02" } });
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
        { first: 0, displacement: 0.02 },
        { first: FIRST_CUT, shot_type: "wide" },
      ],
      target_fps: 24,
      platform: "web",
    });
  });

  it("a per-row Reset returns the scene to auto (and drops it from the request)", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();

    fireEvent.change(within(sceneRow(0)).getByLabelText("Scene 1 displacement"), {
      target: { value: "0.02" },
    });
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
  it("Inpainted is the DEFAULT (×1.6 on the quote); Splatted is the cheap opt-out", async () => {
    const user = userEvent.setup();
    renderPanel();

    // default mode: inpainted — the preview matches the deliverable
    expect(
      (screen.getByRole("radio", { name: /Inpainted/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);

    await getQuote(user);
    // 149.46 s at 25¢/min → 63¢ base × 1.6 = 101¢ − 50¢ credit = 51¢
    expect(screen.getByTestId("quote-base").textContent).toBe("$0.63");
    expect(screen.getByTestId("quote-inpaint-multiplier").textContent).toBe("×1.6");
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$1.01");
    expect(screen.getByTestId("quote-total").textContent).toBe("$0.51");

    await user.click(screen.getByRole("radio", { name: /Splatted/ }));
    expect(screen.queryByTestId("quote-breakdown")).toBeNull(); // invalidated
    await getQuote(user);
    // 63¢, no multiplier, −50¢ credit → 50¢ floor
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$0.63");
    expect(screen.queryByTestId("quote-inpaint-multiplier")).toBeNull();
    expect(screen.getByTestId("quote-total").textContent).toBe("$0.50");
  });

  it("surfaces the gateway's scene_overrides validation errors", async () => {
    const user = userEvent.setup();
    renderPanel();

    // 0.05 is outside (0, 0.03] — the mock rejects like the gateway
    fireEvent.change(within(sceneRow(0)).getByLabelText("Scene 1 displacement"), {
      target: { value: "0.05" },
    });
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

    fireEvent.change(within(sceneRow(0)).getByLabelText("Scene 1 displacement"), {
      target: { value: "0.02" },
    });
    await user.selectOptions(
      within(sceneRow(FIRST_CUT)).getByLabelText("Scene 2 shot type"),
      "close_up",
    );
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });

    const key = stereoDraftKey(FIXTURE.project_id, VERSION);
    await waitFor(() => {
      const draft = loadStereoDraft(FIXTURE.project_id, VERSION);
      expect(draft.overrides["0"]).toEqual({ displacement: 0.02 });
      expect(draft.overrides[String(FIRST_CUT)]).toEqual({ shot_type: "close_up" });
      expect(draft.depth_scale).toBeCloseTo(1.05, 5);
    });
    expect(window.localStorage.getItem(key)).not.toBeNull();

    // tab switch = unmount/remount — the draft survives
    view.unmount();
    renderPanel();
    expect(
      (within(sceneRow(0)).getByLabelText("Scene 1 displacement") as HTMLInputElement)
        .value,
    ).toBe("0.02");
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

  it("unchecking disables the row's depth controls, mutes the row, and emits EXACTLY {first, passthrough: true} — the stashed displacement stays OFF the wire", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();

    // stash a depth tweak first — it must survive in the DRAFT but be
    // dropped from the request while passthrough is on
    fireEvent.change(within(sceneRow(0)).getByLabelText("Scene 1 displacement"), {
      target: { value: "0.02" },
    });
    await user.click(toggle(0, 1));

    const shot = within(sceneRow(0)).getByLabelText(
      "Scene 1 shot type",
    ) as HTMLSelectElement;
    const disp = within(sceneRow(0)).getByLabelText(
      "Scene 1 displacement",
    ) as HTMLInputElement;
    expect(shot.disabled).toBe(true);
    expect(disp.disabled).toBe(true);
    expect(disp.value).toBe("0.02"); // kept in the UI, just disabled
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
    renderPanel();

    fireEvent.change(within(sceneRow(0)).getByLabelText("Scene 1 displacement"), {
      target: { value: "0.02" },
    });
    await user.click(toggle(0, 1)); // off → passthrough
    await user.click(toggle(0, 1)); // back on

    const disp = within(sceneRow(0)).getByLabelText(
      "Scene 1 displacement",
    ) as HTMLInputElement;
    expect(disp.disabled).toBe(false);
    expect(disp.value).toBe("0.02");
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

    // rows re-seeded from the profiled shots (mock bucket 0 = standard,
    // displacement 0.01) — and the action is gone (profile now fresh)
    const shot = within(sceneRow(0)).getByLabelText(
      "Scene 1 shot type",
    ) as HTMLSelectElement;
    expect(shot.selectedOptions[0].textContent).toBe("Auto (standard)");
    const disp = within(sceneRow(0)).getByLabelText(
      "Scene 1 displacement",
    ) as HTMLInputElement;
    expect(disp.placeholder).toBe("0.0100");
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
