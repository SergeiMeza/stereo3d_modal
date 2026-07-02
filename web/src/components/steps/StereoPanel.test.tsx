/**
 * Stereo page tests: per-scene rows derived from the fixture's REAL cuts
 * (frame ranges + timecodes via frames.ts, never hardcoded), scene_profile
 * seeding + the stale-profile warning, ONLY-changed-rows scene_overrides on
 * the wire (displacement top-level ABSENT), the ×1.6 inpaint quote line,
 * and localStorage draft persistence (the store Deliver inherits).
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

import type {
  Conversion,
  Project,
  SceneProfile,
  StepConversionRequest,
} from "@/lib/api/types";
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

import { loadStereoDraft, stereoDraftKey } from "./stereoStore";
import { StereoPanel } from "./StereoPanel";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 50 }));

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
      formats: ["sbs"],
      inpaint: "none",
      scene_overrides: [
        { first: 0, displacement: 0.02 },
        { first: FIRST_CUT, shot_type: "wide" },
      ],
      target_fps: 12,
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

  it("offers sbs (default) + half_sbs + anaglyph — no tb, no mvhevc — and sends the picked set", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();

    const formats = screen.getByRole("group", { name: "Formats" });
    const boxes = within(formats).getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    expect(
      (within(formats).getByRole("checkbox", { name: "SBS" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(within(formats).queryByRole("checkbox", { name: "MV-HEVC" })).toBeNull();
    expect(within(formats).queryByRole("checkbox", { name: "TB" })).toBeNull();

    await user.click(within(formats).getByRole("checkbox", { name: "Anaglyph" }));
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].formats).toEqual(["sbs", "anaglyph"]);
  });
});

describe("StereoPanel quote pricing", () => {
  it("splatted (default) prices without the inpaint line; Inpainted shows ×1.6", async () => {
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    // 149.46 s at 25¢/min → 63¢, no multiplier, −50¢ credit → 50¢ floor
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$0.63");
    expect(screen.queryByTestId("quote-inpaint-multiplier")).toBeNull();
    expect(screen.getByTestId("quote-total").textContent).toBe("$0.50");

    await user.click(screen.getByRole("radio", { name: /Inpainted/ }));
    expect(screen.queryByTestId("quote-breakdown")).toBeNull(); // invalidated
    await getQuote(user);
    // 63¢ × 1.6 = 101¢ − 50¢ credit = 51¢
    expect(screen.getByTestId("quote-base").textContent).toBe("$0.63");
    expect(screen.getByTestId("quote-inpaint-multiplier").textContent).toBe("×1.6");
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$1.01");
    expect(screen.getByTestId("quote-total").textContent).toBe("$0.51");
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

describe("StereoPanel output player (scene-scoped playback)", () => {
  const RANGES = cutsToRanges(CUTS, N);

  function sceneLabel([first, last]: [number, number], i: number): string {
    return `Scene ${i + 1} · f${first}–f${last} · ${frameToTimecode(first, FPS)}`;
  }

  it("plays the last succeeded run's SBS output theater-wide with a scene picker derived from the cuts", async () => {
    const project = fixtureProject();
    project.conversions = [seededStereoRun(project.project_id)];
    renderPanel(project);

    const video = (await screen.findByTestId(
      "stereo-output-video",
    )) as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe(
      (downloadsFixture.downloads as Record<string, string>).sbs,
    );
    expect(screen.getByTestId("stereo-output").textContent).toContain("sbs");

    const picker = screen.getByLabelText("Scene to play") as HTMLSelectElement;
    expect(picker.value).toBe(""); // Whole video default
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      "Whole video",
      ...RANGES.map(sceneLabel),
    ]);
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
    expect(screen.getByTestId("stereo-output").textContent).toContain(
      "half_sbs",
    );
  });

  it("picking a scene seeks to frameToSeconds(first, SOURCE fps) and loops within [startT, endT); Whole video clears the loop", async () => {
    const user = userEvent.setup();
    const project = fixtureProject();
    project.conversions = [seededStereoRun(project.project_id)];
    renderPanel(project);

    const video = (await screen.findByTestId(
      "stereo-output-video",
    )) as HTMLVideoElement;
    const picker = screen.getByLabelText("Scene to play") as HTMLSelectElement;
    const [first, last] = RANGES[1]; // scene 2 = [FIRST_CUT, CUTS[1])
    const startT = frameToSeconds(first, FPS);
    const endT = frameToSeconds(last, FPS);

    await user.selectOptions(picker, "1");
    expect(video.currentTime).toBeCloseTo(startT, 5);

    // playback reaching the scene end loops back (and keeps playing — the
    // component never pauses)
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause");
    video.currentTime = endT + 0.1;
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBeCloseTo(startT, 5);
    expect(pauseSpy).not.toHaveBeenCalled();

    // ‹ / › steppers drive the same player
    fireEvent.click(screen.getByLabelText("Next scene"));
    expect(picker.value).toBe("2");
    expect(video.currentTime).toBeCloseTo(frameToSeconds(RANGES[2][0], FPS), 5);

    // Whole video: loop cleared, no seek
    await user.selectOptions(picker, "");
    const past = endT + 5;
    video.currentTime = past;
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBeCloseTo(past, 5);
  });

  it("badges the output with its format + decoded size, and Space toggles play/pause", async () => {
    const project = fixtureProject();
    project.conversions = [seededStereoRun(project.project_id)];
    renderPanel(project);

    const video = (await screen.findByTestId(
      "stereo-output-video",
    )) as HTMLVideoElement;

    // before metadata the badge only NAMES the output
    expect(screen.getByTestId("stereo-output-badge").textContent).toBe("sbs");
    Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 540, configurable: true });
    fireEvent(video, new Event("loadedmetadata"));
    expect(screen.getByTestId("stereo-output-badge").textContent).toBe(
      "sbs 1920×540",
    );

    // Space plays the paused output (shared player shortcut)…
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(() => Promise.resolve());
    fireEvent.keyDown(window, { key: " " });
    expect(playSpy).toHaveBeenCalledTimes(1);

    // …and pauses it once playing
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    const pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    fireEvent.keyDown(window, { key: " " });
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it("the Speed select sets playbackRate on the output player", async () => {
    const user = userEvent.setup();
    const project = fixtureProject();
    project.conversions = [seededStereoRun(project.project_id)];
    renderPanel(project);

    const video = (await screen.findByTestId(
      "stereo-output-video",
    )) as HTMLVideoElement;
    const speed = screen.getByLabelText("Speed") as HTMLSelectElement;
    expect(speed.value).toBe("1");
    expect(video.playbackRate).toBe(1);

    await user.selectOptions(speed, "1.5");
    expect(video.playbackRate).toBe(1.5);
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
