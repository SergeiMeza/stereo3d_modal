/**
 * Depth page tests: the depth_res/fps-only surface (no displacement, no
 * preset, no formats), request bodies on the wire, the depth_res_factor
 * quote line, the ONE-transport review area (the depth_vis follower beside
 * the main preview, synced off the master video's element events), the
 * Cut-style timeline + auto-scrolling scene grid, depth-map export/import,
 * and the shared checkout machinery (idempotency, lifecycle, cancel)
 * inherited from useStepCheckout.
 *
 * Quote expectations follow the mock's math on the real fixture:
 * 3587 frames @ 24 fps = 149.46 s → base 312¢ at $1.25/min (full-rate fps
 * factor 1); the letterboxed 2.39:1 content (crop 3840:1606) prices the
 * depth work at ×1.345 even at the 980 base → 420¢ subtotal − 50¢ analyze
 * credit = $3.70.
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
  StepConversionRequest,
} from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { cutsToRanges, frameToTimecode, parseRational } from "@/lib/frames";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import downloadsFixture from "../../../fixtures/downloads_succeeded.json";
import projectFixture from "../../../fixtures/project.json";

import { DepthPanel } from "./DepthPanel";
import { loadStereoDraft } from "./stereoStore";

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
  window.localStorage.clear(); // the panel mounts the shared stereo draft
});
afterAll(() => server.close());

function fixtureProject(overrides: Partial<Project> = {}): Project {
  return {
    ...(structuredClone(projectFixture) as unknown as Project),
    ...overrides,
  };
}

const FIXTURE = projectFixture as unknown as Project;
const FPS = parseRational(FIXTURE.probe!.fps_rational);
const RANGES = cutsToRanges(FIXTURE.scenes!.cuts, FIXTURE.probe!.num_frames);
const REAL_DOWNLOADS = downloadsFixture.downloads as Record<string, string>;

function renderPanel(project: Project = fixtureProject()) {
  const onProjectChanged = vi.fn();
  const utils = render(
    <AuthProvider>
      <DepthPanel project={project} onProjectChanged={onProjectChanged} />
    </AuthProvider>,
  );
  return { onProjectChanged, ...utils };
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

/** Render with a seeded succeeded run and wait for the follower video. */
async function renderWithDepth(project = fixtureProject()) {
  project.conversions = [seededDepthRun(project.project_id)];
  const rendered = renderPanel(project);
  const depth = (await screen.findByTestId("depth-video")) as HTMLVideoElement;
  const master = screen.getByTestId("preview-video") as HTMLVideoElement;
  return { ...rendered, project, master, depth };
}

describe("DepthPanel controls", () => {
  it("offers depth resolutions (no GPU tier) capped at source, with a source-native choice, 980 Standard preselected", () => {
    // An UNCROPPED 3840×2160 source → short side 2160; the 2520 preset
    // exceeds it and is dropped, and the 2156 preset (⌊2160/14⌋·14) is the
    // ceiling, relabeled source native. Labels carry NO GPU tier.
    renderPanel(fixtureProject({ crop: undefined }));
    const select = document.getElementById("depth-res") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "518 — Draft",
      "700",
      "980 — Standard",
      "1148 — High",
      "1442 — Very high",
      "1610",
      "1806",
      "2100",
      "2156 — source native",
    ]);
    expect(select.value).toBe("980");
  });

  it("caps the choices at the POST-CROP dims for a letterboxed wide source", () => {
    // The fixture is a 2.39:1 film in a 16:9 3840×2160 container (crop
    // 3840:1606:0:276): depth runs on the bar-cropped frames, so the
    // container options (2100, 2156) must NOT be offered — 2100 would fail
    // on the backend at 2100² × 2.39 = 10.54 MP, over the 8.5 MP VRAM
    // ceiling. The cropped short side (⌊1606/14⌋·14 = 1596) is the ceiling.
    renderPanel();
    const select = document.getElementById("depth-res") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "518 — Draft",
      "700",
      "980 — Standard",
      "1148 — High",
      "1442 — Very high",
      "1596 — source native",
    ]);
  });

  it("exposes NO displacement, preset, formats, fps, or anaglyph copy — depth_res only", () => {
    renderPanel();
    const panel = screen.getByTestId("depth-panel");
    expect(within(panel).queryByText(/displacement/i)).toBeNull();
    expect(within(panel).queryByRole("slider")).toBeNull();
    expect(within(panel).queryByRole("group", { name: "Formats" })).toBeNull();
    expect(document.getElementById("depth-preset")).toBeNull();
    // no frame-rate control in this version — previews run at the source rate
    expect(document.getElementById("depth-fps")).toBeNull();
    expect(within(panel).queryByText(/frame rate/i)).toBeNull();
    expect(within(panel).queryByText(/anaglyph/i)).toBeNull();
  });
});

describe("DepthPanel quotes", () => {
  it("sends EXACTLY step + depth_res + target_fps (+platform) on the wire — target_fps pinned to the FULL source rate", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    await waitFor(() => expect(bodies).toHaveLength(1));
    // exact object: proves displacement/preset/formats are ABSENT, and that
    // target_fps is still sent (an absent one means half-rate at the gateway)
    expect(bodies[0]).toEqual({
      step: "depth_preview",
      depth_res: 980,
      target_fps: 24,
      platform: "web",
    });
  });

  it("renders plain quote line items on a 16:9 source (no depth factor line at ×1.0)", async () => {
    // An UNCROPPED 16:9 source: the working-MP factor is exactly 1.0 at the
    // 980 base, so no adjustment lines render. The mock quotes from ITS
    // project record, so clear the crop there too.
    mockDb.projects.get(FIXTURE.project_id)!.crop = undefined;
    const user = userEvent.setup();
    renderPanel(fixtureProject({ crop: undefined }));
    await getQuote(user);

    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$3.12");
    expect(screen.getByText(/2\.49 min × \$1\.25\/min/)).toBeDefined();
    expect(screen.getByTestId("quote-analyze-credit").textContent).toBe("−$0.50");
    expect(screen.getByTestId("quote-total").textContent).toBe("$2.62");
    expect(screen.queryByTestId("quote-depth-factor")).toBeNull();
    expect(screen.queryByTestId("quote-base")).toBeNull();

    // the coarse processing-time estimate, clearly labeled as an estimate
    // (mock: 149.46 s × 2.5 → 374 s → "~6 min")
    expect(screen.getByText(/Estimated processing time/)).toBeDefined();
    expect(screen.getByTestId("quote-eta").textContent).toBe("~6 min");
  });

  it("prices the letterboxed 2.39:1 content with the aspect-aware depth factor", async () => {
    // The fixture's crop (3840:1606) makes the depth work ×1.345 the 16:9
    // anchor at the SAME depth_res 980 — wide frames are more pixels.
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    expect(screen.getByTestId("quote-base").textContent).toBe("$3.12");
    expect(screen.getByTestId("quote-depth-factor").textContent).toBe("×1.34");
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$4.20");
    expect(screen.getByTestId("quote-total").textContent).toBe("$3.70");
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
    // base 312¢ × clamp(1442²×2.391 / (980²×16⁄9), 0.5, 5) = ×2.91 → 909¢
    expect(screen.getByTestId("quote-base").textContent).toBe("$3.12");
    expect(screen.getByTestId("quote-depth-factor").textContent).toBe("×2.91");
    expect(screen.getByText("1442 px")).toBeDefined();
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$9.09");
    expect(screen.getByTestId("quote-total").textContent).toBe("$8.59");
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

describe("DepthPanel in-flight state survival (checkoutStore)", () => {
  it("keeps the in-progress tracker across unmount/remount (tab navigation)", async () => {
    // The workspace panels unmount on every tab switch; the in-flight run
    // lives in the shared per-(project, step) store, so coming back must
    // show the tracker again — NOT a fresh Convert UI for a job that is
    // still running (and billing).
    const user = userEvent.setup();
    const project = fixtureProject();
    const first = renderPanel(project);
    await getQuote(user);
    await user.click(screen.getByRole("button", { name: "Convert · $3.70" }));
    await screen.findByTestId("conversion-tracker");

    first.unmount();
    renderPanel(project);

    expect(screen.getByTestId("conversion-tracker")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Convert ·/ })).toBeNull();
  });

  it("resumes a still-running conversion from the project on a fresh mount (page reload)", async () => {
    // A reload loses the jotai store, but the gateway persists conversions
    // (Firestore) and returns them with the project — the panel adopts the
    // newest still-running step conversion and tracks it.
    const project = fixtureProject();
    const running = seededDepthRun(project.project_id, {
      conversion_id: "runningdepth1",
      state: "processing",
      progress: 0.4,
      outputs: [],
    });
    project.conversions = [running];
    renderPanel(project);

    expect(await screen.findByTestId("conversion-tracker")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Convert ·/ })).toBeNull();
  });

  it("does NOT resume terminal conversions from the project history", () => {
    // Prior succeeded/failed runs are history (PriorRuns/review area), not
    // an in-flight job — a fresh mount must offer the normal quote flow.
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)]; // succeeded
    renderPanel(project);

    expect(screen.queryByTestId("conversion-tracker")).toBeNull();
  });
});

describe("DepthPanel conversion lifecycle (shared useStepCheckout)", () => {
  it("blocks with the onboarding notice when no payment method is saved (gateway 402 no_payment_method)", async () => {
    mockDb.billing.hasPaymentMethod = false;
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    await user.click(screen.getByRole("button", { name: "Convert · $3.70" }));

    const notice = await screen.findByTestId("billing-block");
    expect(notice.textContent).toContain("payment method");
    const link = within(notice).getByRole("link", { name: /Set up billing/ });
    expect(link.getAttribute("href")).toBe("/onboarding");
    expect(mockDb.conversions.size).toBe(0);
  });

  it("blocks with the settle notice when an automatic charge is outstanding (gateway 402 billing_overdue)", async () => {
    mockDb.billing.unpaid.push({
      conversion_id: "m0cdeadbeef1",
      amount_cents: 120,
      currency: "usd",
      needs_action: false,
    });
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    await user.click(screen.getByRole("button", { name: "Convert · $3.70" }));

    const notice = await screen.findByTestId("billing-block");
    expect(notice.textContent).toContain("automatic payment failed");
    expect(mockDb.conversions.size).toBe(0);
  });

  it("runs convert → poll to succeeded with NO payment step; the tracker reports state WITHOUT a downloads list (the review area owns the outputs)", async () => {
    const user = userEvent.setup();
    const { onProjectChanged } = renderPanel();
    await getQuote(user);

    await user.click(screen.getByRole("button", { name: "Convert · $3.70" }));

    await screen.findByText("processing", undefined, { timeout: 3000 });
    await screen.findByText("succeeded", undefined, { timeout: 3000 });
    await waitFor(() => expect(onProjectChanged).toHaveBeenCalledTimes(1));

    // the automatic charge landed
    const conv = [...mockDb.conversions.values()][0];
    expect(conv.billing).toEqual({
      status: "charged",
      charged_cents: conv.quote.amount_cents,
    });

    // NO download links/players inside the tracker on the Depth tab — the
    // side-by-side depth view + Export replaced that surface
    const tracker = screen.getByTestId("conversion-tracker");
    expect(within(tracker).queryByRole("link")).toBeNull();
    expect(within(tracker).queryByTestId("preview-depth_vis")).toBeNull();
    expect(within(tracker).queryByText("Downloads")).toBeNull();

    // the mocked success also stamps the project's scene_profile
    const project = mockDb.projects.get(
      (projectFixture as { project_id: string }).project_id,
    )!;
    expect(project.scene_profile).toBeDefined();
    expect(project.scene_profile!.scenes_version).toBe(project.scenes!.version);
  });

  it("surfaces a failed automatic charge on the tracker after success", async () => {
    mockDb.billing.nextChargeFails = true;
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    await user.click(screen.getByRole("button", { name: "Convert · $3.70" }));

    await screen.findByText("succeeded", undefined, { timeout: 3000 });
    const warning = await screen.findByTestId("charge-failed");
    expect(warning.textContent).toContain("automatic payment");
    expect(mockDb.billing.unpaid).toHaveLength(1);
  });

  it("places an up-front hold on expensive runs and completes a 3DS challenge with the saved card", async () => {
    mockDb.billing.holdThresholdCents = 50; // the $3.70 quote now holds
    mockDb.billing.nextHoldRequiresAction = true;
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    await user.click(screen.getByRole("button", { name: "Convert · $3.70" }));

    // completeChargeAction auto-confirms; the mock flips created→paid and
    // the run proceeds to success with the hold captured
    await screen.findByText("succeeded", undefined, { timeout: 3000 });
    const conv = [...mockDb.conversions.values()][0];
    expect(conv.billing).toEqual({
      status: "charged",
      charged_cents: conv.quote.amount_cents,
    });
  });

  it("blocks with the declined-card notice when the up-front hold is declined (402 card_declined)", async () => {
    mockDb.billing.holdThresholdCents = 50;
    mockDb.billing.nextHoldFails = true;
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    await user.click(screen.getByRole("button", { name: "Convert · $3.70" }));

    const notice = await screen.findByTestId("billing-block");
    expect(notice.textContent).toContain("declined");
    expect(
      within(notice).getByRole("link", { name: /Update your card/ }).getAttribute("href"),
    ).toBe("/account");
    expect(mockDb.conversions.size).toBe(0);
  });

  it("reuses the Idempotency-Key on double-submit — no second conversion", async () => {
    const user = userEvent.setup();
    renderPanel();
    await getQuote(user);

    const convert = screen.getByRole("button", { name: "Convert · $3.70" });
    await user.click(convert);
    await screen.findByTestId("conversion-tracker");
    await user.click(convert); // same attempt, second submit

    await waitFor(() => expect(mockDb.idem.size).toBe(1));
    expect(mockDb.conversions.size).toBe(1);
  });

  it("cancels an active conversion while processing", async () => {
    const user = userEvent.setup();
    const { onProjectChanged } = renderPanel();
    await getQuote(user);

    await user.click(screen.getByRole("button", { name: "Convert · $3.70" }));

    await screen.findByText("processing", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await screen.findByText("canceled", undefined, { timeout: 3000 });
    const conv = [...mockDb.conversions.values()][0];
    expect(conv.state).toBe("canceled");
    expect(onProjectChanged).not.toHaveBeenCalled();
  });
});

describe("DepthPanel depth follower (one transport)", () => {
  it("renders the last succeeded run's depth_vis BESIDE the main preview — no second transport", async () => {
    const { project, master, depth } = await renderWithDepth();
    expect(master.getAttribute("src")).toBe(project.preview_url);
    expect(depth.getAttribute("src")).toBe(REAL_DOWNLOADS.depth_vis);

    // ONE transport: the main preview's. No compare-specific controls left.
    expect(screen.getByLabelText("Play preview")).toBeDefined();
    expect(screen.queryByLabelText("Play comparison")).toBeNull();
    expect(screen.queryByLabelText("Scene to play")).toBeNull();
    expect(screen.getAllByLabelText("Speed")).toHaveLength(1);
  });

  it("the MAIN Play/Pause drives both videos (the follower mirrors the master's play/pause events)", async () => {
    const { depth } = await renderWithDepth();

    const playSpy = vi.spyOn(depth, "play");
    fireEvent.click(screen.getByLabelText("Play preview"));
    expect(playSpy).toHaveBeenCalledTimes(1); // master play event → follower

    const pauseSpy = vi.spyOn(depth, "pause");
    fireEvent.click(screen.getByLabelText("Pause preview"));
    expect(pauseSpy).toHaveBeenCalled();
  });

  it("Space (the main transport key) also reaches the follower", async () => {
    const { depth } = await renderWithDepth();
    const playSpy = vi.spyOn(depth, "play");
    fireEvent.keyDown(window, { key: " " });
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("syncs the follower by FRACTION of duration on master timeupdate and seeked (never frame math)", async () => {
    const { master, depth } = await renderWithDepth();
    Object.defineProperty(master, "duration", { value: 100, configurable: true });
    Object.defineProperty(depth, "duration", { value: 50, configurable: true });

    // while playing: timeupdate
    master.currentTime = 40;
    fireEvent.timeUpdate(master);
    expect(depth.currentTime).toBeCloseTo(20, 5);

    // paused seeks (timeline scrubs, scene-card jumps, frame steps) fire
    // seeked, not timeupdate — the follower must track those too
    master.currentTime = 80;
    fireEvent.seeked(master);
    expect(depth.currentTime).toBeCloseTo(40, 5);
  });

  it("mirrors the master's playbackRate on ratechange — the fraction-sync would fight a different speed", async () => {
    const { master, depth } = await renderWithDepth();
    const speed = screen.getByLabelText("Speed") as HTMLSelectElement;
    await userEvent.setup().selectOptions(speed, "0.5");
    expect(master.playbackRate).toBe(0.5);
    // jsdom doesn't dispatch ratechange on assignment — fire it like a browser
    fireEvent(master, new Event("ratechange"));
    expect(depth.playbackRate).toBe(0.5);
  });

  it("unmuting the main transport gives sound to the MASTER only — the depth follower STAYS muted", async () => {
    const { master, depth } = await renderWithDepth();
    expect(master.muted).toBe(true);
    expect(depth.muted).toBe(true);

    fireEvent.click(screen.getByLabelText("Unmute"));
    expect(master.muted).toBe(false); // the source proxy carries the audio
    expect(depth.muted).toBe(true); // the follower must never double-play

    fireEvent.click(screen.getByLabelText("Mute"));
    expect(master.muted).toBe(true);
  });

  it("badges the follower and reveals its decoded size once metadata lands", async () => {
    const { depth } = await renderWithDepth();
    expect(screen.getByTestId("depth-video-badge").textContent).toBe("depth_vis");

    Object.defineProperty(depth, "videoWidth", { value: 1232, configurable: true });
    Object.defineProperty(depth, "videoHeight", { value: 518, configurable: true });
    fireEvent(depth, new Event("loadedmetadata"));
    expect(screen.getByTestId("depth-video-badge").textContent).toBe(
      "depth_vis 1232×518",
    );
  });

  it("falls back gracefully when the run produced no depth_vis", async () => {
    const project = fixtureProject();
    project.conversions = [
      seededDepthRun(project.project_id, {
        outputs: ["anaglyph", "depth"], // pre-depth_vis capture
      }),
    ];
    renderPanel(project);

    await screen.findByTestId("depth-video-missing");
    expect(screen.queryByTestId("depth-video")).toBeNull();
  });

  it("shows no depth slot at all (single full-width preview) without a succeeded run", () => {
    renderPanel();
    expect(screen.queryByTestId("depth-video")).toBeNull();
    expect(screen.queryByTestId("depth-video-missing")).toBeNull();
    expect(
      screen.getByText(/Run a depth preview to see the depth map/),
    ).toBeDefined();
  });
});

describe("DepthPanel timeline (Cut-style)", () => {
  it("renders the read-only filmstrip with the project's cut markers (inert) and the playhead", () => {
    renderPanel();
    const strip = screen.getByTestId("filmstrip");
    expect(strip).toBeDefined();
    const markers = screen.getAllByTestId("cut-marker");
    // first cut is frame 0 → cutsToRanges implies cuts.length markers
    expect(markers).toHaveLength(FIXTURE.scenes!.cuts.length);
    // readOnly markers are inert DIVs, not draggable buttons
    for (const m of markers) expect(m.tagName).toBe("DIV");
    expect(screen.getByTestId("playhead")).toBeDefined();
    // the detected active-picture (crop) overlay renders on the preview,
    // same as Media/Cut (the fixture's source is letterboxed)
    expect(screen.getByTestId("crop-overlay")).toBeDefined();
  });
});

describe("DepthPanel scene grid (shared 2D passthrough)", () => {
  it("shows one card per scene (number + timecode) with a Convert-to-3D toggle, default checked, and says depth previews are unaffected", () => {
    renderPanel();
    const strip = screen.getByTestId("depth-scenes");
    const rows = within(strip).getAllByTestId(/^depth-scene-\d/);
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

  it("clicking a scene card seeks the MAIN preview to the scene's first frame and scrolls the active row to the top", async () => {
    // jsdom has no Element.scrollTo — provide one so the auto-scroll runs
    const scrollTo = vi.fn();
    (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo = scrollTo;
    try {
      const { master } = await renderWithDepth();
      const [start] = RANGES[2];
      const card = screen
        .getByTestId(`depth-scene-${start}`)
        .querySelector("button")!;
      fireEvent.click(card);
      // frame-exact seek: mid-frame time of the scene's first frame
      expect(master.currentTime).toBeGreaterThan(0);
      expect(screen.getByTestId("frame-readout").textContent).toContain(
        `f${start}`,
      );
      // the playhead crossed into a new scene → its card scrolled to the top
      expect(scrollTo).toHaveBeenCalled();
    } finally {
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("unchecking a scene writes passthrough into the SHARED stereo draft AND onto the depth request (black depth, no AI pass)", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByLabelText("Scene 1 convert to 3D"));
    expect(
      loadStereoDraft(FIXTURE.project_id, FIXTURE.scenes!.version).overrides["0"],
    ).toEqual({ passthrough: true });
    expect(screen.getByTestId("depth-scene-0").className).toContain("opacity-60");

    // the passthrough set rides the depth request as passthrough-ONLY
    // scene_overrides — the backend skips those scenes' AI depth pass
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      step: "depth_preview",
      depth_res: 980,
      target_fps: 24,
      platform: "web",
      scene_overrides: [{ first: 0, passthrough: true }],
    });

    // re-checking clears the flag from the shared draft — and STALES the
    // fetched quote (the priced request changed), so Convert disappears
    // until a re-quote, exactly like changing depth_res
    await user.click(screen.getByLabelText("Scene 1 convert to 3D"));
    expect(
      loadStereoDraft(FIXTURE.project_id, FIXTURE.scenes!.version).overrides["0"],
    ).toBeUndefined();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Convert ·/ })).toBeNull(),
    );

    // the fresh quote carries NO scene_overrides again
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({
      step: "depth_preview",
      depth_res: 980,
      target_fps: 24,
      platform: "web",
    });
  });
});

describe("DepthPanel depth-map export / import", () => {
  it("replaces the prior-runs downloads card: no PriorRuns section even with prior conversions", async () => {
    await renderWithDepth();
    expect(screen.queryByTestId("prior-runs")).toBeNull();
    expect(screen.queryByText("Prior depth runs")).toBeNull();
  });

  it("Export is disabled until a run succeeded, then opens a dialog explaining the 10-bit raw file and linking the `depth` download", async () => {
    const { unmount } = render(
      <AuthProvider>
        <DepthPanel project={fixtureProject()} onProjectChanged={vi.fn()} />
      </AuthProvider>,
    );
    const disabled = screen.getByRole("button", {
      name: "Export depth map",
    }) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    unmount();

    await renderWithDepth();
    const button = screen.getByRole("button", {
      name: "Export depth map",
    }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));

    fireEvent.click(button);
    const dialog = await screen.findByTestId("export-depth-dialog");
    // the dialog names WHAT is exported: the full-precision 10-bit depth
    // file, explicitly NOT the 8-bit depth_vis preview
    expect(dialog.textContent).toContain("10-bit");
    expect(dialog.textContent).toContain("not the 8-bit");
    const link = within(dialog).getByTestId("export-depth-link");
    expect(link.getAttribute("href")).toBe(REAL_DOWNLOADS.depth);
    expect(link.getAttribute("download")).not.toBeNull();
  });

  it("imports a local depth video into the compare slot (object URL, review-only) and clears back to the run's depth_vis", async () => {
    const createObjectURL = vi.fn(() => "blob:imported-depth");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    const { depth } = await renderWithDepth();
    expect(depth.getAttribute("src")).toBe(REAL_DOWNLOADS.depth_vis);

    const user = userEvent.setup();
    const file = new File(["x"], "my-depth.mp4", { type: "video/mp4" });
    await user.upload(screen.getByLabelText("Depth map file"), file);

    const importedVideo = screen.getByTestId("depth-video") as HTMLVideoElement;
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(importedVideo.getAttribute("src")).toBe("blob:imported-depth");
    expect(screen.getByTestId("depth-video-badge").textContent).toBe(
      "imported depth",
    );
    // the note names the file and that nothing is uploaded
    const note = screen.getByTestId("imported-depth-note");
    expect(note.textContent).toContain("my-depth.mp4");
    expect(note.textContent).toContain("local review only");

    // clearing reverts to the run's depth_vis and revokes the object URL
    fireEvent.click(screen.getByLabelText("Clear imported depth map"));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:imported-depth");
    expect(
      (screen.getByTestId("depth-video") as HTMLVideoElement).getAttribute("src"),
    ).toBe(REAL_DOWNLOADS.depth_vis);
    expect(screen.getByTestId("depth-video-badge").textContent).toBe("depth_vis");
  });

  it("import works with NO depth run — an external depth map previews beside the source", async () => {
    const createObjectURL = vi.fn(() => "blob:external-depth");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });

    renderPanel();
    expect(screen.queryByTestId("depth-video")).toBeNull();

    const user = userEvent.setup();
    const file = new File(["x"], "external.mp4", { type: "video/mp4" });
    await user.upload(screen.getByLabelText("Depth map file"), file);

    const video = screen.getByTestId("depth-video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe("blob:external-depth");
    expect(screen.getByTestId("depth-video-badge").textContent).toBe(
      "imported depth",
    );
  });
});
