/**
 * Depth page tests: the depth_res/fps-only surface (no displacement, no
 * preset, no formats), request bodies on the wire, the depth_res_factor
 * quote line, the source-vs-depth compare view with its fraction-synced
 * transport, prior-runs listing, and the shared checkout machinery
 * (idempotency, lifecycle, cancel) inherited from useStepCheckout.
 *
 * Quote expectations follow the mock's math on the real fixture:
 * 3587 frames @ 24 fps = 149.46 s → base 25¢ at 10¢/min; −50¢ analyze
 * credit; 50¢ minimum floor.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

import { DepthPanel } from "./DepthPanel";
import { loadStereoDraft } from "./stereoStore";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 50 }));

// jsdom's HTMLMediaElement.play/pause are "not implemented"; stub them to
// dispatch their events so the compare transport stays honest.
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
  window.localStorage.clear(); // the panel now mounts the shared stereo draft
});
afterAll(() => server.close());

function fixtureProject(overrides: Partial<Project> = {}): Project {
  return {
    ...(structuredClone(projectFixture) as unknown as Project),
    ...overrides,
  };
}

const FIXTURE = projectFixture as unknown as Project;
const PROFILE = (sceneProfileFixture as { scene_profile: unknown })
  .scene_profile as SceneProfile;
const FPS = parseRational(FIXTURE.probe!.fps_rational);
/** Scene ranges the picker must derive when no (fresh) profile exists. */
const RANGES = cutsToRanges(FIXTURE.scenes!.cuts, FIXTURE.probe!.num_frames);

function sceneLabel([first, last]: [number, number], i: number): string {
  return `Scene ${i + 1} · f${first}–f${last} · ${frameToTimecode(first, FPS)}`;
}

function renderPanel(project: Project = fixtureProject()) {
  const onProjectChanged = vi.fn();
  render(
    <AuthProvider>
      <DepthPanel project={project} onProjectChanged={onProjectChanged} />
    </AuthProvider>,
  );
  return { onProjectChanged };
}

/** Record every quote request body the panel puts on the wire. */
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

/** A succeeded depth run seeded into BOTH the mock db (so /downloads works)
 * and the returned conversion (for project.conversions). */
function seededDepthRun(
  projectId: string,
  overrides: Partial<Conversion> = {},
): Conversion {
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
      depth_res: 980,
      target_fps: 12,
    },
    quote: { amount_cents: 50, currency: "usd" },
    progress: 1,
    outputs: ["anaglyph", "depth", "depth_vis"],
    created_at: "2026-07-02T08:00:00Z",
    updated_at: "2026-07-02T08:05:00Z",
    ...overrides,
  };
  mockDb.conversions.set(conv.conversion_id, structuredClone(conv));
  return conv;
}

describe("DepthPanel controls", () => {
  it("offers exactly the sold depth resolutions with GPU-tier hints, 980 Standard preselected", () => {
    renderPanel();
    const select = document.getElementById("depth-res") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "518 — Draft · L40S",
      "700 · L40S",
      "980 — Standard · L40S",
      "1148 — High · L40S",
      "1442 — Very high · H200",
      "2100 · B200",
      "2520 — Maximum · B200",
    ]);
    expect(select.value).toBe("980");
  });

  it("offers only source-derived fps options, ½ rate (12) preselected as the PREVIEW rate", () => {
    renderPanel();
    const fps = document.getElementById("depth-fps") as HTMLSelectElement;
    // 24/1 source → full first, then divisors; no invented rates
    expect([...fps.options].map((o) => o.textContent)).toEqual([
      "24 (full)",
      "12 (½ rate)",
      "8 (⅓ rate)",
      "6 (¼ rate)",
      "4 (⅙ rate)",
      "3 (⅛ rate)",
      "2 (1⁄12 rate)",
    ]);
    expect(fps.value).toBe("12");
  });

  it("exposes NO displacement, preset, formats, or anaglyph copy — depth_res and fps only", () => {
    renderPanel();
    const panel = screen.getByTestId("depth-panel");
    expect(within(panel).queryByText(/displacement/i)).toBeNull();
    expect(within(panel).queryByRole("slider")).toBeNull();
    expect(within(panel).queryByRole("group", { name: "Formats" })).toBeNull();
    expect(document.getElementById("depth-preset")).toBeNull();
    expect(within(panel).queryByText(/anaglyph/i)).toBeNull();
  });
});

describe("DepthPanel quotes", () => {
  it("sends EXACTLY step + depth_res + target_fps (+platform) on the wire", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    await waitFor(() => expect(bodies).toHaveLength(1));
    // exact object: proves displacement/preset/formats are ABSENT
    expect(bodies[0]).toEqual({
      step: "depth_preview",
      depth_res: 980,
      target_fps: 12,
      platform: "web",
    });
  });

  it("renders the standard-res quote line items (no depth factor line at ×1.0)", async () => {
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$0.25");
    expect(screen.getByText("2.49 min × $0.10/min")).toBeDefined();
    expect(screen.getByTestId("quote-analyze-credit").textContent).toBe("−$0.50");
    expect(screen.getByTestId("quote-total").textContent).toBe("$0.50");
    expect(screen.queryByTestId("quote-depth-factor")).toBeNull();
    expect(screen.queryByTestId("quote-base")).toBeNull();

    // the coarse processing-time estimate, clearly labeled as an estimate
    // (mock: 149.46 s × 0.8 → 120 s → "~2 min")
    expect(screen.getByText(/Estimated processing time/)).toBeDefined();
    expect(screen.getByTestId("quote-eta").textContent).toBe("~2 min");
  });

  it("renders the depth_res_factor line for a higher resolution and invalidates the quote on change", async () => {
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    // param change → the quote is stale and disappears
    await user.selectOptions(
      document.getElementById("depth-res")!,
      "1442",
    );
    expect(screen.queryByTestId("quote-breakdown")).toBeNull();
    expect(screen.queryByRole("button", { name: /Convert/ })).toBeNull();

    await getQuote(user);
    // base 25¢ × clamp((1442/980)², 0.5, 4) = ×2.17 → 54¢ subtotal
    expect(screen.getByTestId("quote-base").textContent).toBe("$0.25");
    expect(screen.getByTestId("quote-depth-factor").textContent).toBe("×2.17");
    expect(screen.getByText("1442 px")).toBeDefined();
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$0.54");
    expect(screen.getByTestId("quote-total").textContent).toBe("$0.50");
  });

  it("surfaces the gateway's 400 invalid_request message on the panel", async () => {
    // the panel only offers valid depth_res values, so force the error
    // response; the mock's validation rules themselves are covered in
    // src/mocks/handlers.test.ts
    const { HttpResponse, http } = await import("msw");
    const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
    server.use(
      http.post(`${GATEWAY}/v1/projects/:id/quotes`, () =>
        HttpResponse.json(
          {
            success: false,
            error: "invalid_request",
            message: "depth_res must be a multiple of 14 in [140, 2520]",
          },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Get quote" }));
    expect(
      await screen.findByText("depth_res must be a multiple of 14 in [140, 2520]"),
    ).toBeDefined();
    expect(screen.queryByTestId("quote-breakdown")).toBeNull();
  });
});

describe("DepthPanel checkout lifecycle (shared useStepCheckout)", () => {
  it("runs create → pay → poll to succeeded → downloads include the playable depth_vis", async () => {
    const user = userEvent.setup();
    const { onProjectChanged } = renderPanel();
    await getQuote(user);

    await user.click(screen.getByRole("button", { name: "Convert · $0.50" }));
    const checkout = await screen.findByTestId("mock-checkout");
    expect(checkout.textContent).toContain("$0.50");

    await user.click(
      within(checkout).getByRole("button", { name: "Pay (test)" }),
    );

    await screen.findByText("processing", undefined, { timeout: 3000 });
    await screen.findByText("succeeded", undefined, { timeout: 3000 });
    await waitFor(() => expect(onProjectChanged).toHaveBeenCalledTimes(1));

    // outputs: anaglyph + depth + depth_vis; depth_vis plays inline, raw
    // depth stays a plain link
    await screen.findByRole("link", { name: "depth_vis" });
    expect(screen.getByTestId("preview-depth_vis").tagName).toBe("VIDEO");
    expect(screen.getByRole("link", { name: "depth" })).toBeDefined();
    expect(screen.queryByTestId("preview-depth")).toBeNull();

    // the mocked success also stamps the project's scene_profile
    const project = mockDb.projects.get(
      (projectFixture as { project_id: string }).project_id,
    )!;
    expect(project.scene_profile).toBeDefined();
    expect(project.scene_profile!.scenes_version).toBe(project.scenes!.version);
  });

  it("reuses the Idempotency-Key on double-submit — no second conversion", async () => {
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    const convert = screen.getByRole("button", { name: "Convert · $0.50" });
    await user.click(convert);
    await screen.findByTestId("mock-checkout");
    await user.click(convert); // same attempt, second submit

    await waitFor(() => expect(mockDb.idem.size).toBe(1));
    expect(mockDb.conversions.size).toBe(1);
  });

  it("cancels an active conversion while processing", async () => {
    const user = userEvent.setup();
    const { onProjectChanged } = renderPanel();
    await getQuote(user);

    await user.click(screen.getByRole("button", { name: "Convert · $0.50" }));
    const checkout = await screen.findByTestId("mock-checkout");
    await user.click(
      within(checkout).getByRole("button", { name: "Pay (test)" }),
    );

    await screen.findByText("processing", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await screen.findByText("canceled", undefined, { timeout: 3000 });
    const conv = [...mockDb.conversions.values()][0];
    expect(conv.state).toBe("canceled");
    expect(onProjectChanged).not.toHaveBeenCalled();
  });
});

describe("DepthPanel compare view", () => {
  it("plays the last succeeded run's depth_vis NEXT TO the source proxy with a fraction-synced transport", async () => {
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    renderPanel(project);

    await screen.findByTestId("depth-compare");
    const source = screen.getByTestId("depth-compare-source") as HTMLVideoElement;
    const depth = screen.getByTestId("depth-compare-depth") as HTMLVideoElement;
    expect(source.getAttribute("src")).toBe(project.preview_url);
    expect(depth.getAttribute("src")).toBe(
      (downloadsFixture.downloads as Record<string, string>).depth_vis,
    );

    // one transport for both players
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play");
    fireEvent.click(screen.getByLabelText("Play comparison"));
    expect(playSpy).toHaveBeenCalledTimes(2);

    // follower syncs by FRACTION of duration (the depth video may run at a
    // different fps — no frame math against it)
    Object.defineProperty(source, "duration", { value: 100, configurable: true });
    Object.defineProperty(depth, "duration", { value: 50, configurable: true });
    source.currentTime = 40;
    fireEvent.timeUpdate(source);
    expect(depth.currentTime).toBeCloseTo(20, 5);

    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause");
    fireEvent.click(screen.getByLabelText("Pause comparison"));
    expect(pauseSpy).toHaveBeenCalledTimes(2);
  });

  it("badges each player with what it shows and its decoded size once metadata lands", async () => {
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    renderPanel(project);
    await screen.findByTestId("depth-compare");
    const source = screen.getByTestId("depth-compare-source") as HTMLVideoElement;
    const depth = screen.getByTestId("depth-compare-depth") as HTMLVideoElement;

    // before metadata the badges only NAME the streams
    expect(screen.getByTestId("depth-compare-source-badge").textContent).toBe(
      "source proxy",
    );
    expect(screen.getByTestId("depth-compare-depth-badge").textContent).toBe(
      "depth_vis",
    );

    // loadedmetadata reveals the ACTUAL decoded videoWidth×videoHeight
    Object.defineProperty(source, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(source, "videoHeight", { value: 360, configurable: true });
    fireEvent(source, new Event("loadedmetadata"));
    expect(screen.getByTestId("depth-compare-source-badge").textContent).toBe(
      "source proxy 640×360",
    );

    Object.defineProperty(depth, "videoWidth", { value: 1232, configurable: true });
    Object.defineProperty(depth, "videoHeight", { value: 518, configurable: true });
    fireEvent(depth, new Event("loadedmetadata"));
    expect(screen.getByTestId("depth-compare-depth-badge").textContent).toBe(
      "depth_vis 1232×518",
    );
  });

  it("Space toggles the comparison transport (shared player shortcut, BOTH players)", async () => {
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    renderPanel(project);
    await screen.findByTestId("depth-compare");

    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play");
    fireEvent.keyDown(window, { key: " " });
    expect(playSpy).toHaveBeenCalledTimes(2); // source AND depth
    expect(screen.getByLabelText("Pause comparison")).toBeTruthy();

    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause");
    fireEvent.keyDown(window, { key: " " });
    expect(pauseSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Play comparison")).toBeTruthy();
  });

  it("unmuting gives sound to the MASTER only — the depth_vis follower STAYS muted", async () => {
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    renderPanel(project);
    await screen.findByTestId("depth-compare");
    const source = screen.getByTestId("depth-compare-source") as HTMLVideoElement;
    const depth = screen.getByTestId("depth-compare-depth") as HTMLVideoElement;

    // both start muted (autoplay policy)
    expect(source.muted).toBe(true);
    expect(depth.muted).toBe(true);

    fireEvent.click(screen.getByLabelText("Unmute"));
    expect(source.muted).toBe(false); // master = the source proxy (has audio)
    expect(depth.muted).toBe(true); // follower must never double-play sound

    fireEvent.click(screen.getByLabelText("Mute"));
    expect(source.muted).toBe(true);
    expect(depth.muted).toBe(true);
  });

  it("falls back gracefully when the run produced no depth_vis", async () => {
    const project = fixtureProject();
    project.conversions = [
      seededDepthRun(project.project_id, {
        outputs: ["anaglyph", "depth"], // pre-depth_vis capture
      }),
    ];
    renderPanel(project);

    await screen.findByTestId("depth-compare-missing");
    expect(screen.queryByTestId("depth-compare")).toBeNull();
  });
});

describe("DepthPanel scene-scoped playback", () => {
  /** Render with a seeded succeeded run and wait for the compare view. */
  async function renderCompare(project = fixtureProject()) {
    project.conversions = [seededDepthRun(project.project_id)];
    renderPanel(project);
    await screen.findByTestId("depth-compare");
    return {
      picker: screen.getByLabelText("Scene to play") as HTMLSelectElement,
      source: screen.getByTestId("depth-compare-source") as HTMLVideoElement,
      depth: screen.getByTestId("depth-compare-depth") as HTMLVideoElement,
    };
  }

  it("offers Whole video (default) + one option per scene, labels DERIVED from the fixture's cuts", async () => {
    const { picker } = await renderCompare();
    expect(picker.value).toBe(""); // Whole video preselected
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      "Whole video",
      ...RANGES.map(sceneLabel),
    ]);
  });

  it("prefers a FRESH scene_profile's shot ranges; a stale one falls back to the cuts", async () => {
    const withProfile = fixtureProject();
    withProfile.scene_profile = structuredClone(PROFILE) as SceneProfile;
    withProfile.scene_profile.scenes_version = withProfile.scenes!.version;
    const { picker } = await renderCompare(withProfile);
    // the profiled shots are the exact ranges the pipeline rendered — the
    // fixture's last shot ends at last_src (≠ num_frames), which proves the
    // options came from the profile, not cutsToRanges
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      "Whole video",
      ...PROFILE.shots.map((s, i) =>
        sceneLabel([s.first_src, s.last_src], i),
      ),
    ]);
    cleanup();

    const stale = fixtureProject();
    stale.scene_profile = structuredClone(PROFILE) as SceneProfile;
    stale.scene_profile.scenes_version = stale.scenes!.version - 1;
    const again = await renderCompare(stale);
    expect([...again.picker.options].map((o) => o.textContent)).toEqual([
      "Whole video",
      ...RANGES.map(sceneLabel),
    ]);
  });

  it("picking a scene seeks the MASTER to the scene start (source time), stays paused, and loops at the boundary with the follower in sync", async () => {
    const user = userEvent.setup();
    const { picker, source, depth } = await renderCompare();
    const [first, last] = RANGES[2];
    const startT = frameToSeconds(first, FPS);
    const endT = frameToSeconds(last, FPS);

    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play");
    await user.selectOptions(picker, "2");
    expect(source.currentTime).toBeCloseTo(startT, 5);
    expect(playSpy).not.toHaveBeenCalled(); // picked while paused → stays paused

    // inside the scene: no seeking
    Object.defineProperty(source, "duration", {
      value: FIXTURE.probe!.duration_s,
      configurable: true,
    });
    Object.defineProperty(depth, "duration", {
      value: FIXTURE.probe!.duration_s,
      configurable: true,
    });
    const mid = (startT + endT) / 2;
    source.currentTime = mid;
    fireEvent.timeUpdate(source);
    expect(source.currentTime).toBeCloseTo(mid, 5);

    // past the end: loop back to the start, follower tracks the looped time
    source.currentTime = endT + 0.2;
    fireEvent.timeUpdate(source);
    expect(source.currentTime).toBeCloseTo(startT, 5);
    expect(depth.currentTime).toBeCloseTo(startT, 5); // equal durations → equal fraction
  });

  it("a PAUSED scene pick syncs the follower via seeked (timeupdate never fires while paused)", async () => {
    const user = userEvent.setup();
    const { picker, source, depth } = await renderCompare();
    for (const v of [source, depth]) {
      Object.defineProperty(v, "duration", {
        value: FIXTURE.probe!.duration_s,
        configurable: true,
      });
    }

    const startT = frameToSeconds(RANGES[2][0], FPS);
    await user.selectOptions(picker, "2"); // paused pick → master seeks
    expect(source.currentTime).toBeCloseTo(startT, 5);
    // the browser answers the seek with a 'seeked' event, not 'timeupdate'
    fireEvent.seeked(source);
    expect(depth.currentTime).toBeCloseTo(startT, 5);
  });

  it("‹ / › step scenes: › from Whole video goes to Scene 1, ‹ from Scene 1 returns to Whole video, › stops at the last scene", async () => {
    const user = userEvent.setup();
    const { picker, source } = await renderCompare();
    const prev = screen.getByLabelText("Previous scene") as HTMLButtonElement;
    const next = screen.getByLabelText("Next scene") as HTMLButtonElement;

    expect(prev.disabled).toBe(true); // Whole video — nothing before it
    fireEvent.click(next);
    expect(picker.value).toBe("0"); // Scene 1
    fireEvent.click(next);
    expect(picker.value).toBe("1"); // Scene 2 — and the master followed
    expect(source.currentTime).toBeCloseTo(frameToSeconds(RANGES[1][0], FPS), 5);
    fireEvent.click(prev);
    expect(picker.value).toBe("0");
    fireEvent.click(prev);
    expect(picker.value).toBe(""); // back to Whole video
    expect(prev.disabled).toBe(true);

    await user.selectOptions(picker, String(RANGES.length - 1));
    expect(next.disabled).toBe(true); // last scene — no further
    fireEvent.click(prev);
    expect(picker.value).toBe(String(RANGES.length - 2));
  });

  it("switching back to Whole video clears the loop and does NOT seek", async () => {
    const user = userEvent.setup();
    const { picker, source } = await renderCompare();
    const [, last] = RANGES[0];
    await user.selectOptions(picker, "0");

    await user.selectOptions(picker, "");
    const past = frameToSeconds(last, FPS) + 3; // well past the old scene end
    source.currentTime = past;
    fireEvent.timeUpdate(source);
    expect(source.currentTime).toBeCloseTo(past, 5); // no loop, no seek
  });

  it("re-applies the scene seek on loadedmetadata when the video had no metadata yet — exactly once", async () => {
    const user = userEvent.setup();
    const { picker, source } = await renderCompare();
    const startT = frameToSeconds(RANGES[2][0], FPS);

    // jsdom videos report readyState 0 (no metadata) — the seek is pending
    expect(source.readyState).toBe(0);
    await user.selectOptions(picker, "2");
    source.currentTime = 0; // the browser dropped the pre-metadata seek
    fireEvent(source, new Event("loadedmetadata"));
    expect(source.currentTime).toBeCloseTo(startT, 5);

    // a later loadedmetadata must not re-seek (pending consumed)
    source.currentTime = 1;
    fireEvent(source, new Event("loadedmetadata"));
    expect(source.currentTime).toBe(1);
  });

  it("the Speed select (0.25×–2×, 1× default) sets playbackRate on BOTH compare players", async () => {
    const user = userEvent.setup();
    const { source, depth } = await renderCompare();

    const speed = screen.getByLabelText("Speed") as HTMLSelectElement;
    expect(speed.value).toBe("1");
    expect([...speed.options].map((o) => o.textContent)).toEqual([
      "0.25×",
      "0.5×",
      "1×",
      "1.5×",
      "2×",
    ]);
    expect(source.playbackRate).toBe(1);

    await user.selectOptions(speed, "0.5");
    // master AND follower share the rate — the fraction-sync would fight a
    // follower running at a different speed
    expect(source.playbackRate).toBe(0.5);
    expect(depth.playbackRate).toBe(0.5);

    await user.selectOptions(speed, "2");
    expect(source.playbackRate).toBe(2);
    expect(depth.playbackRate).toBe(2);
  });
});

describe("DepthPanel scenes strip (shared 2D passthrough)", () => {
  it("lists one row per scene (number + timecode) with a Convert-to-3D toggle, default checked, and says depth previews are unaffected", () => {
    renderPanel();
    const strip = screen.getByTestId("depth-scenes");
    const rows = within(strip).getAllByTestId(/^depth-scene-/);
    expect(rows).toHaveLength(RANGES.length);
    expect(rows[0].textContent).toContain("Scene 1");
    expect(rows[0].textContent).toContain(frameToTimecode(0, FPS));
    const toggle = within(strip).getByLabelText(
      "Scene 1 convert to 3D",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(
      screen.getByText(
        /Depth previews always render the full depth map regardless/,
      ),
    ).toBeDefined();
  });

  it("unchecking a scene writes passthrough into the SHARED stereo draft and never touches the depth request", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByLabelText("Scene 1 convert to 3D"));
    expect(
      loadStereoDraft(FIXTURE.project_id, FIXTURE.scenes!.version).overrides["0"],
    ).toEqual({ passthrough: true });
    expect(screen.getByTestId("depth-scene-0").className).toContain("opacity-60");

    // passthrough affects stereo_preview/production only — the depth quote
    // request stays EXACTLY the depth_res/fps surface
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      step: "depth_preview",
      depth_res: 980,
      target_fps: 12,
      platform: "web",
    });

    // re-checking clears the flag from the shared draft
    await user.click(screen.getByLabelText("Scene 1 convert to 3D"));
    expect(
      loadStereoDraft(FIXTURE.project_id, FIXTURE.scenes!.version).overrides["0"],
    ).toBeUndefined();
  });
});

describe("DepthPanel prior runs", () => {
  it("lists prior depth runs with state, depth_res, fps and price, depth_vis playable", async () => {
    const user = userEvent.setup();
    const project = fixtureProject();
    const ok = seededDepthRun(project.project_id);
    const failed = seededDepthRun(project.project_id, {
      conversion_id: "prior0000002",
      state: "failed",
      params: { preset: "draft", formats: ["anaglyph"], depth_res: 1442, target_fps: 24 },
      outputs: undefined,
      created_at: "2026-07-02T09:00:00Z",
    });
    project.conversions = [ok, failed];
    renderPanel(project);

    const rows = await screen.findAllByTestId(/^prior-run-/);
    expect(rows).toHaveLength(2);
    // newest first
    expect(rows[0].getAttribute("data-testid")).toBe("prior-run-prior0000002");
    expect(rows[0].textContent).toContain("depth 1442 · 24 fps");
    expect(rows[0].textContent).toContain("failed");
    expect(rows[1].textContent).toContain("depth 980 · 12 fps");
    expect(rows[1].textContent).toContain("$0.50");

    // only the succeeded run offers downloads; its depth_vis plays inline
    await user.click(screen.getByRole("button", { name: "Downloads" }));
    const vis = await screen.findAllByTestId("preview-depth_vis");
    expect(vis.length).toBeGreaterThanOrEqual(1);
  });
});
