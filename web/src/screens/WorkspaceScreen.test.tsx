/**
 * Workspace screen tests — run against the stateful MSW gateway seeded
 * from the REAL captured fixture (web/fixtures/project.json).
 *
 * Frame doctrine: every expected value is computed with the helpers in
 * src/lib/frames.ts (and their windowed compositions in workspace utils).
 * Counts and cut values are DERIVED from the fixture, never hardcoded —
 * the fixture is recaptured from the live API and the scene detector
 * varies ±1 cut between captures.
 *
 * jsdom has no media playback: HTMLMediaElement.play/pause are stubbed to
 * dispatch their events (below), and every frame assertion drives the
 * component's own seek path rather than awaiting real playback.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import projectFixture from "../../fixtures/project.json";
import { WHEEL_ZOOM_THRESHOLD } from "@/components/workspace/FilmstripTimeline";
import { seekTimeForFrame } from "@/components/workspace/usePreviewPlayer";
import {
  frameToWindowPosition,
  windowPositionToFrame,
  zoomLevels,
  type FrameWindow,
} from "@/components/workspace/utils";
import type { Probe, Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import {
  frameLabel,
  frameToPosition,
  frameToTimecode,
  parseRational,
  positionToFrame,
} from "@/lib/frames";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import WorkspaceScreen from "@/screens/WorkspaceScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/projects/a1b2c3d4e5f6",
  useParams: () => ({ id: "a1b2c3d4e5f6" }),
  useSearchParams: () => new URLSearchParams(),
}));

// The step panels are mocked to their shared contract (project +
// onProjectChanged) so these tests assert the screen's wiring (through the
// REAL StepTab) without the quote/checkout flows; those are covered by the
// per-panel tests (DepthPanel/StereoPanel/DeliverPanel .test.tsx).
function fakePanel(step: string) {
  function FakePanel({
    project,
    onProjectChanged,
  }: {
    project: Project;
    onProjectChanged: () => void;
  }) {
    return (
      <div data-testid={`step-card-${step}`}>
        <span data-testid="step-card-project">{project.project_id}</span>
        <button type="button" onClick={() => void onProjectChanged()}>
          refresh project
        </button>
      </div>
    );
  }
  return FakePanel;
}
vi.mock("@/components/steps/DepthPanel", () => ({
  DepthPanel: fakePanel("depth_preview"),
}));
vi.mock("@/components/steps/StereoPanel", () => ({
  StereoPanel: fakePanel("stereo_preview"),
}));
vi.mock("@/components/steps/DeliverPanel", () => ({
  DeliverPanel: fakePanel("production"),
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

const FIXTURE = projectFixture as unknown as Project;
const PID = FIXTURE.project_id;

function fixtureProbe(): Probe {
  if (!FIXTURE.probe) throw new Error("fixture is missing probe");
  return FIXTURE.probe;
}

const PROBE = fixtureProbe();
const N = PROBE.num_frames;
const FPS = parseRational(PROBE.fps_rational);
const SCENES_VERSION = FIXTURE.scenes?.version ?? 0;
const CUTS = FIXTURE.scenes?.cuts ?? [];
const NCUTS = CUTS.length;
if (NCUTS < 3) throw new Error("fixture must have at least 3 scene cuts");
const FIRST_CUT = CUTS[0];
const SECOND_CUT = CUTS[1];
const LAST_CUT = CUTS[NCUTS - 1];
/** A frame that is a legal NEW cut: strictly inside (0, FIRST_CUT), so it
 * can never collide with a detected cut regardless of the capture. */
const NEW_CUT = Math.floor(FIRST_CUT / 2);
if (NEW_CUT <= 0 || CUTS.includes(NEW_CUT)) {
  throw new Error("fixture's first cut is too early to derive NEW_CUT");
}
const STRIP_THUMBS = FIXTURE.strip_thumbs ?? [];

/** The strip tile covering `frame` (largest thumb.frame <= frame). */
function nearestStripFrame(frame: number): number {
  const covered = STRIP_THUMBS.filter((t) => t.frame <= frame);
  if (covered.length === 0) throw new Error(`no strip thumb covers ${frame}`);
  return Math.max(...covered.map((t) => t.frame));
}

// jsdom's HTMLMediaElement.play/pause are "not implemented"; stub them to
// dispatch their events so usePreviewPlayer's state stays honest. Assigned
// once for this file (vitest isolates environments per test file).
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
  server.resetHandlers();
  server.events.removeAllListeners();
  mockDb.reset();
  cleanup();
  vi.restoreAllMocks();
  // page switches persist in the URL hash — reset so every test starts on
  // the default (Cut) page
  window.history.replaceState(null, "", window.location.pathname);
});
afterAll(() => server.close());

async function renderWorkspace(pollIntervalMs?: number): Promise<HTMLElement> {
  render(
    <AuthProvider>
      <WorkspaceScreen projectId={PID} pollIntervalMs={pollIntervalMs} />
    </AuthProvider>,
  );
  return screen.findByTestId("filmstrip");
}

/** The Cut page timeline OPENS at the deepest zoom (precision-first);
 * tests that hit-test with 1 px = 1 frame coordinates first zoom back out
 * to fit, the geometry the assertions are written against. */
function zoomToFit(strip: HTMLElement): void {
  const zoomOut = screen.getByLabelText("Zoom out") as HTMLButtonElement;
  while (!zoomOut.disabled) fireEvent.click(zoomOut);
  expect(strip.getAttribute("data-zoom")).toBe("1");
}

/** Give the strip a deterministic 1 px = 1 frame geometry (jsdom has no
 * layout), so at fit zoom positionToFrame(clientX / N, N) === floor(clientX). */
function mockStripRect(strip: HTMLElement): void {
  vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: N,
    bottom: 90,
    width: N,
    height: 90,
    toJSON: () => ({}),
  } as DOMRect);
}

function markerFrames(): number[] {
  return screen
    .getAllByTestId("cut-marker")
    .map((m) => Number(m.getAttribute("data-frame")));
}

function readout(): string {
  return screen.getByTestId("frame-readout").textContent ?? "";
}

function previewVideo(): HTMLVideoElement {
  return screen.getByTestId("preview-video") as HTMLVideoElement;
}

/** The visible frame window the strip exposes for assertions. */
function stripWindow(strip: HTMLElement): FrameWindow & { zoom: number } {
  return {
    zoom: Number(strip.getAttribute("data-zoom")),
    start: Number(strip.getAttribute("data-window-start")),
    frames: Number(strip.getAttribute("data-window-frames")),
  };
}

function capturePatchBodies(): Array<{ cuts: number[]; expect_version?: number }> {
  const bodies: Array<{ cuts: number[]; expect_version?: number }> = [];
  server.events.on("request:start", ({ request }) => {
    if (request.method === "PATCH" && request.url.endsWith("/scenes")) {
      void request
        .clone()
        .json()
        .then((b) =>
          bodies.push(b as { cuts: number[]; expect_version?: number }),
        );
    }
  });
  return bodies;
}

/** Bump the server-side scene version behind the UI's back (simulates a
 * concurrent editor) via a direct fetch through the MSW gateway. */
async function bumpServerScenes(cuts: number[]): Promise<void> {
  const version = mockDb.projects.get(PID)?.scenes?.version;
  const res = await fetch(`${GATEWAY}/v1/projects/${PID}/scenes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cuts, expect_version: version }),
  });
  if (!res.ok) throw new Error(`bumpServerScenes failed (${res.status})`);
}

describe("WorkspaceScreen — fixture rendering", () => {
  it("renders one scene card per cut+1, every cut marker, and the exact duration timecode", async () => {
    await renderWorkspace();

    expect(screen.getAllByTestId("scene-card")).toHaveLength(NCUTS + 1);
    expect(screen.getAllByTestId("cut-marker")).toHaveLength(NCUTS);
    expect(markerFrames()).toEqual(CUTS);

    // Duration computed through the frames.ts helper, never floats.
    expect(screen.getByTestId("duration").textContent).toBe(
      frameToTimecode(N, FPS),
    );

    // version badge + no dirty indicator on a pristine load
    expect(screen.getByTestId("scenes-version").textContent).toBe(
      `v${SCENES_VERSION}`,
    );
    expect(screen.queryByTestId("dirty-indicator")).toBeNull();

    // playhead readout starts at frame 0
    expect(readout()).toBe(frameLabel(0, FPS));

    // the frame-exact preview proxy is wired into the viewer
    expect(previewVideo().getAttribute("src")).toBe(FIXTURE.preview_url);
  });

  it("shows the crop overlay scaled from source dims over the preview video", async () => {
    await renderWorkspace();

    if (!FIXTURE.crop) throw new Error("fixture is missing crop");
    const [cw, ch, cx, cy] = FIXTURE.crop.split(":").map(Number);

    const overlay = screen.getByTestId("crop-overlay");
    expect(overlay.style.left).toBe(`${(cx / PROBE.width) * 100}%`);
    expect(overlay.style.top).toBe(`${(cy / PROBE.height) * 100}%`);
    expect(overlay.style.width).toBe(`${(cw / PROBE.width) * 100}%`);
    expect(overlay.style.height).toBe(`${(ch / PROBE.height) * 100}%`);

    // with a preview proxy the viewer plays video, not thumbnails
    expect(screen.queryByTestId("viewer-frame")).toBeNull();
  });

  it("badges the viewer with the proxy's ACTUAL decoded resolution", async () => {
    await renderWorkspace();

    // before metadata: proxy named but unmeasured; tooltip carries the
    // frame-doctrine reassurance with the SOURCE dimensions
    const badge = screen.getByTestId("proxy-badge");
    expect(badge.textContent).toBe("Proxy");
    expect(badge.getAttribute("title")).toContain(
      `${PROBE.width}×${PROBE.height}`,
    );
    expect(badge.getAttribute("title")).toMatch(/frame-exact/i);

    // loadedmetadata reveals the real videoWidth×videoHeight (not hardcoded)
    const video = previewVideo();
    Object.defineProperty(video, "videoWidth", {
      value: 640,
      configurable: true,
    });
    Object.defineProperty(video, "videoHeight", {
      value: 360,
      configurable: true,
    });
    fireEvent(video, new Event("loadedmetadata"));
    expect(screen.getByTestId("proxy-badge").textContent).toBe("Proxy 640×360");
  });

  it("falls back to the nearest strip thumbnail when the project has no preview proxy", async () => {
    const noProxy = structuredClone(projectFixture) as unknown as Project;
    delete noProxy.preview_url;
    server.use(
      http.get(`${GATEWAY}/v1/projects/:id`, () => HttpResponse.json(noProxy)),
    );

    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);

    expect(screen.queryByTestId("preview-video")).toBeNull();
    // the badge names the static fallback for what it is
    expect(screen.getByTestId("proxy-badge").textContent).toBe("Thumbnail");
    expect(
      screen.getByTestId("viewer-frame").getAttribute("data-thumb-frame"),
    ).toBe("0");
    // playback is unavailable without the proxy
    expect(
      (screen.getByLabelText("Play preview") as HTMLButtonElement).disabled,
    ).toBe(true);

    // scrubbing shows the tile covering the frame (largest frame <= playhead)
    fireEvent.click(strip, { clientX: 100 });
    expect(
      screen.getByTestId("viewer-frame").getAttribute("data-thumb-frame"),
    ).toBe(String(nearestStripFrame(100)));
  });

  it("⌘/Ctrl+scroll accumulates wheel deltas — a trackpad pinch steps one level per gesture, not per event", async () => {
    const strip = await renderWorkspace();
    const start = Number(strip.getAttribute("data-zoom")); // deepest at mount
    const small = WHEEL_ZOOM_THRESHOLD / 8; // a pinch-sized delta

    // seven small deltas stay under the threshold: no zoom change
    for (let i = 0; i < 7; i++) {
      fireEvent.wheel(strip, { deltaY: small, ctrlKey: true });
    }
    expect(Number(strip.getAttribute("data-zoom"))).toBe(start);
    // the eighth crosses it: exactly ONE level out (was one PER event)
    fireEvent.wheel(strip, { deltaY: small, ctrlKey: true });
    expect(Number(strip.getAttribute("data-zoom"))).toBe(start / 2);
    // a full mouse notch (≥ threshold) steps immediately
    fireEvent.wheel(strip, { deltaY: WHEEL_ZOOM_THRESHOLD + 20, ctrlKey: true });
    expect(Number(strip.getAttribute("data-zoom"))).toBe(start / 4);
    // direction flip discards the remainder — a small opposite delta
    // doesn't inherit the previous direction's accumulated credit
    fireEvent.wheel(strip, { deltaY: -small, ctrlKey: true });
    expect(Number(strip.getAttribute("data-zoom"))).toBe(start / 4);
    // without the modifier nothing zooms
    fireEvent.wheel(strip, { deltaY: 10 * WHEEL_ZOOM_THRESHOLD });
    expect(Number(strip.getAttribute("data-zoom"))).toBe(start / 4);
  });

  it("obeys the frame-doctrine invariant for every rendered marker", async () => {
    await renderWorkspace();
    const frames = markerFrames();
    expect(frames).toHaveLength(NCUTS);
    for (const f of frames) {
      expect(positionToFrame(frameToPosition(f, N), N)).toBe(f);
    }
  });

  it("shows the analyzing state and polls until analysis lands", async () => {
    const running = structuredClone(projectFixture) as unknown as Project;
    running.analyze = {
      state: "running",
      error: "",
      credit_cents: 0,
      credit_available: false,
    };
    delete running.probe;
    delete running.scenes;
    delete running.strip_thumbs;
    delete running.scene_thumbs;
    server.use(
      http.get(
        `${GATEWAY}/v1/projects/:id`,
        () => HttpResponse.json(running),
        { once: true },
      ),
    );

    render(
      <AuthProvider>
        <WorkspaceScreen projectId={PID} pollIntervalMs={25} />
      </AuthProvider>,
    );

    await screen.findByTestId("analyzing-state");
    // next poll hits the default handler (analysis succeeded)
    await screen.findByTestId("filmstrip");
    expect(screen.queryByTestId("analyzing-state")).toBeNull();
  });
});

describe("WorkspaceScreen — playhead & keyboard", () => {
  it("click on the strip moves the playhead and seeks the video mid-frame", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);

    fireEvent.click(strip, { clientX: 100 });
    expect(readout()).toBe(frameLabel(100, FPS));
    // the proxy seeks to the frame's MID-point (never a boundary time)
    expect(previewVideo().currentTime).toBe(seekTimeForFrame(100, FPS));
  });

  it("steps exactly ±1 frame with arrows and ±1 s with Shift, clamped to [0, N)", async () => {
    await renderWorkspace();

    expect(readout()).toBe(frameLabel(0, FPS));

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(readout()).toBe(frameLabel(0, FPS)); // clamped at 0

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(readout()).toBe(frameLabel(1, FPS)); // exact +1

    const second = Math.round(FPS.num / FPS.den);
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(readout()).toBe(frameLabel(1 + second, FPS));

    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    expect(readout()).toBe(frameLabel(1, FPS));

    // jump near the end via the last scene card (starts at the last cut)
    const cards = screen.getAllByTestId("scene-card");
    fireEvent.click(cards[cards.length - 1]);
    expect(readout()).toBe(frameLabel(LAST_CUT, FPS));

    for (let f = LAST_CUT; f < N - 1; f++) {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    }
    expect(readout()).toBe(frameLabel(N - 1, FPS));

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(readout()).toBe(frameLabel(N - 1, FPS)); // never exceeds
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(readout()).toBe(frameLabel(N - 1, FPS));
  });

  it("stepper buttons step ±1 frame", async () => {
    await renderWorkspace();
    fireEvent.click(screen.getByLabelText("Step forward one frame"));
    fireEvent.click(screen.getByLabelText("Step forward one frame"));
    expect(readout()).toBe(frameLabel(2, FPS));
    fireEvent.click(screen.getByLabelText("Step back one frame"));
    expect(readout()).toBe(frameLabel(1, FPS));
  });

  it("play button and Space toggle playback of the preview proxy", async () => {
    await renderWorkspace();

    fireEvent.click(screen.getByLabelText("Play preview"));
    expect(screen.getByLabelText("Pause preview")).toBeTruthy();

    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByLabelText("Play preview")).toBeTruthy();
    // pausing snaps the video to the exact frame's mid-point
    const frame = Number(/f(\d+)$/.exec(readout())?.[1]);
    expect(previewVideo().currentTime).toBe(seekTimeForFrame(frame, FPS));

    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByLabelText("Pause preview")).toBeTruthy();
  });

  it("mouse clicks blur editing buttons so Space keeps meaning play/pause; keyboard clicks keep focus", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);

    fireEvent.click(strip, { clientX: NEW_CUT }); // park on a legal cut frame
    const add = screen.getByText("+ Add cut at playhead") as HTMLButtonElement;

    // MOUSE activation (click detail > 0): the cut is added and the button
    // is blurred, so the next Space is play/pause — not a second add
    add.focus();
    fireEvent.click(add, { detail: 1 });
    const expected = [...CUTS, NEW_CUT].sort((a, b) => a - b);
    expect(markerFrames()).toEqual(expected);
    expect(document.activeElement).not.toBe(add);

    fireEvent.keyDown(document.activeElement ?? window, { key: " " });
    expect(screen.getByLabelText("Pause preview")).toBeTruthy(); // playing
    expect(markerFrames()).toEqual(expected); // no second cut

    // KEYBOARD activation (click detail 0): focus stays on the control so
    // tab users can keep operating it with Space/Enter
    const stepForward = screen.getByLabelText("Step forward one frame");
    stepForward.focus();
    fireEvent.click(stepForward); // fireEvent default detail = 0
    expect(document.activeElement).toBe(stepForward);
  });

  it("clicking a scene card moves the playhead and highlights that scene", async () => {
    await renderWorkspace();
    const cards = screen.getAllByTestId("scene-card");

    // scene 2 = [CUTS[0], CUTS[1])
    fireEvent.click(cards[1]);
    expect(readout()).toBe(frameLabel(FIRST_CUT, FPS));
    expect(cards[1].getAttribute("aria-current")).toBe("true");
    expect(cards[0].getAttribute("aria-current")).toBeNull();
  });
});

describe("WorkspaceScreen — zoomable timeline", () => {
  it("the Cut page opens at the DEEPEST zoom, centered on the playhead", async () => {
    const strip = await renderWorkspace();

    const levels = zoomLevels(N);
    const deepest = levels[levels.length - 1];
    expect(deepest).toBeGreaterThan(1);
    // playhead starts at 0 — centering clamps the window to the strip start
    expect(stripWindow(strip)).toEqual({
      zoom: deepest,
      start: 0,
      frames: Math.ceil(N / deepest),
    });
    // fully zoomed in: + is exhausted, Fit stays reachable via −
    expect(
      (screen.getByLabelText("Zoom in") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Zoom out") as HTMLButtonElement).disabled,
    ).toBe(false);
    zoomToFit(strip);
    expect(stripWindow(strip)).toEqual({ zoom: 1, start: 0, frames: N });
  });

  it("zoom in/out changes the visible frame window, recentered on the playhead", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);

    // fit: the window is the whole strip
    zoomToFit(strip);
    expect(stripWindow(strip)).toEqual({ zoom: 1, start: 0, frames: N });

    // move the playhead mid-video so recentering is observable
    const mid = Math.floor(N / 2);
    fireEvent.click(strip, { clientX: mid });

    fireEvent.click(screen.getByLabelText("Zoom in"));
    const w2 = stripWindow(strip);
    expect(w2.zoom).toBe(2);
    expect(w2.frames).toBe(Math.ceil(N / 2));
    expect(w2.start).toBeGreaterThan(0);
    // the playhead stays inside the zoomed window
    expect(mid).toBeGreaterThanOrEqual(w2.start);
    expect(mid).toBeLessThan(w2.start + w2.frames);

    fireEvent.click(screen.getByLabelText("Zoom in"));
    const w4 = stripWindow(strip);
    expect(w4.zoom).toBe(4);
    expect(w4.frames).toBe(Math.ceil(N / 4));
    expect(mid).toBeGreaterThanOrEqual(w4.start);
    expect(mid).toBeLessThan(w4.start + w4.frames);

    fireEvent.click(screen.getByLabelText("Zoom out"));
    fireEvent.click(screen.getByLabelText("Zoom out"));
    const back = stripWindow(strip);
    expect(back).toEqual({ zoom: 1, start: 0, frames: N });
    expect(
      (screen.getByLabelText("Zoom out") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("obeys the frame-doctrine invariant for in-window markers at every zoom level", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);

    // park the playhead on a middle cut so every zoom level keeps at least
    // one marker in the (recentered) window
    const midCut = CUTS[Math.floor(NCUTS / 2)];
    fireEvent.click(strip, { clientX: midCut });

    const zoomIn = screen.getByLabelText("Zoom in") as HTMLButtonElement;
    const seenZooms: number[] = [];
    for (;;) {
      const win = stripWindow(strip);
      seenZooms.push(win.zoom);
      const inWindow = markerFrames().filter(
        (f) => f >= win.start && f < win.start + win.frames,
      );
      expect(inWindow).toContain(midCut);
      for (const f of inWindow) {
        expect(windowPositionToFrame(frameToWindowPosition(f, win), win)).toBe(f);
      }
      if (zoomIn.disabled) break;
      fireEvent.click(zoomIn);
    }
    // the loop actually exercised multiple zoom levels, fit first
    expect(seenZooms.length).toBeGreaterThanOrEqual(3);
    expect(seenZooms[0]).toBe(1);
    expect(seenZooms).toEqual([...seenZooms].sort((a, b) => a - b));
  });

  it("scrub-click while zoomed maps through the window to the absolute frame", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);

    const mid = Math.floor(N / 2);
    fireEvent.click(strip, { clientX: mid });
    fireEvent.click(screen.getByLabelText("Zoom in"));
    fireEvent.click(screen.getByLabelText("Zoom in"));

    const win = stripWindow(strip);
    expect(win.zoom).toBe(4);
    expect(win.start).toBeGreaterThan(0);

    // click 3/4 across the VISIBLE strip
    const clickX = Math.floor(N * 0.75);
    const expected = windowPositionToFrame(clickX / N, win);
    // zoom-aware: an absolute frame inside the window, ≠ the unzoomed mapping
    expect(expected).toBeGreaterThan(win.start);
    expect(expected).toBeLessThan(win.start + win.frames);
    expect(expected).not.toBe(positionToFrame(clickX / N, N));

    fireEvent.click(strip, { clientX: clickX });
    expect(readout()).toBe(frameLabel(expected, FPS));
    expect(previewVideo().currentTime).toBe(seekTimeForFrame(expected, FPS));
  });
});

describe("WorkspaceScreen — cut editing", () => {
  it("double-click adds a cut; markers and scene list update", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);

    fireEvent.doubleClick(strip, { clientX: NEW_CUT });

    expect(screen.getAllByTestId("cut-marker")).toHaveLength(NCUTS + 1);
    expect(screen.getAllByTestId("scene-card")).toHaveLength(NCUTS + 2);
    expect(markerFrames()).toContain(NEW_CUT);
    // sorted insertion
    expect(markerFrames()).toEqual([...CUTS, NEW_CUT].sort((a, b) => a - b));
    // the new cut is selected, showing frame + timecode
    expect(screen.getByTestId("selected-cut").textContent).toContain(
      frameLabel(NEW_CUT, FPS),
    );
    expect(screen.getByTestId("dirty-indicator")).toBeTruthy();
  });

  it("prevents invalid cuts (frame 0 and duplicates)", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);

    fireEvent.doubleClick(strip, { clientX: 0 }); // frame 0 — out of (0, N)
    expect(screen.getAllByTestId("cut-marker")).toHaveLength(NCUTS);
    expect(screen.getByTestId("edit-note")).toBeTruthy();
    expect(screen.queryByTestId("dirty-indicator")).toBeNull();

    fireEvent.doubleClick(strip, { clientX: FIRST_CUT }); // duplicate
    expect(screen.getAllByTestId("cut-marker")).toHaveLength(NCUTS);
    expect(screen.queryByTestId("dirty-indicator")).toBeNull();
  });

  it("clicking a marker selects it (frame + timecode); Delete removes it", async () => {
    await renderWorkspace();
    const marker = screen.getAllByTestId("cut-marker")[0]; // FIRST_CUT

    fireEvent.click(marker);
    const info = screen.getByTestId("selected-cut").textContent ?? "";
    expect(info).toContain(frameLabel(FIRST_CUT, FPS));
    expect(info).toContain(frameToTimecode(FIRST_CUT, FPS));

    fireEvent.keyDown(window, { key: "Delete" });
    expect(screen.getAllByTestId("cut-marker")).toHaveLength(NCUTS - 1);
    expect(screen.getAllByTestId("scene-card")).toHaveLength(NCUTS);
    expect(markerFrames()).not.toContain(FIRST_CUT);
    // first scene now spans to the next cut
    expect(
      screen.getAllByTestId("scene-card")[0].getAttribute("data-end"),
    ).toBe(String(SECOND_CUT));
    expect(screen.queryByTestId("selected-cut")).toBeNull();
  });

  it("Backspace and the × button also remove the selected cut", async () => {
    await renderWorkspace();

    fireEvent.click(screen.getAllByTestId("cut-marker")[1]); // SECOND_CUT
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(markerFrames()).not.toContain(SECOND_CUT);

    fireEvent.click(screen.getAllByTestId("cut-marker")[0]); // FIRST_CUT
    fireEvent.click(screen.getByLabelText("Remove selected cut"));
    expect(markerFrames()).not.toContain(FIRST_CUT);
    expect(screen.getAllByTestId("cut-marker")).toHaveLength(NCUTS - 2);
  });

  it("'Add cut at playhead' adds the exact playhead frame, with reasons while disabled", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);

    const add = screen.getByText("+ Add cut at playhead") as HTMLButtonElement;
    // playhead 0: cuts live in (0, N) — disabled with the reason as title
    expect(add.disabled).toBe(true);
    expect(add.title).toMatch(/after frame 0/i);

    fireEvent.click(strip, { clientX: NEW_CUT }); // scrub to a legal frame
    expect(add.disabled).toBe(false);
    expect(add.title).toContain(`frame ${NEW_CUT}`);
    fireEvent.click(add);

    expect(markerFrames()).toEqual([...CUTS, NEW_CUT].sort((a, b) => a - b));
    expect(screen.getByTestId("dirty-indicator")).toBeTruthy();
    // the playhead now SITS on a cut — disabled again, duplicate reason
    expect(add.disabled).toBe(true);
    expect(add.title).toContain(`already a cut at frame ${NEW_CUT}`);
  });

  it("'Remove cut' removes the selected marker (and only enables with a selection)", async () => {
    await renderWorkspace();

    const remove = screen.getByText("− Remove cut") as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toMatch(/select a cut/i);

    fireEvent.click(screen.getAllByTestId("cut-marker")[0]); // FIRST_CUT
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);

    expect(markerFrames()).not.toContain(FIRST_CUT);
    expect(screen.getAllByTestId("cut-marker")).toHaveLength(NCUTS - 1);
    expect(remove.disabled).toBe(true); // selection cleared with the cut
  });

  it("a scene card's 'Merge ←' removes the cut that STARTS that scene", async () => {
    await renderWorkspace();

    // every scene except the first is mergeable into its predecessor
    const merges = screen.getAllByTestId("merge-scene");
    expect(merges).toHaveLength(NCUTS); // NCUTS+1 scenes, first has none
    expect(merges.map((m) => Number(m.getAttribute("data-start")))).toEqual(
      CUTS,
    );

    // merge scene 3 into scene 2 ⇒ the cut at SECOND_CUT disappears
    fireEvent.click(merges[1]);
    expect(markerFrames()).toEqual(CUTS.filter((c) => c !== SECOND_CUT));
    expect(screen.getAllByTestId("scene-card")).toHaveLength(NCUTS);
    // scene 2 now spans to the old scene 3's end
    expect(
      screen.getAllByTestId("scene-card")[1].getAttribute("data-end"),
    ).toBe(String(CUTS[2]));
    // local edit like any other — dirty until saved, and the card click
    // itself was not triggered (playhead untouched)
    expect(screen.getByTestId("dirty-indicator")).toBeTruthy();
    expect(readout()).toBe(frameLabel(0, FPS));
  });

  it("explains the timeline marks in a legend", async () => {
    await renderWorkspace();
    const legend = screen.getByTestId("timeline-legend");
    expect(legend.textContent).toMatch(/scene cut — the first frame/i);
    expect(legend.textContent).toMatch(/playhead/i);
  });

  it("dragging a marker moves the cut, snapped to frames and clamped between neighbors", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);

    // first cut; neighbors 0 (start) and SECOND_CUT → allowed [1, SECOND_CUT-1]
    let marker = screen.getAllByTestId("cut-marker")[0];
    const target = Math.floor(SECOND_CUT / 2); // inside the allowed range

    fireEvent.pointerDown(marker, { pointerId: 1, clientX: FIRST_CUT });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: target });
    expect(marker.getAttribute("data-frame")).toBe(String(target));
    // dragging shows a live frame + timecode label
    expect(screen.getByTestId("drag-label").textContent).toBe(
      frameLabel(target, FPS),
    );

    // past the right neighbor → clamped to SECOND_CUT - 1 (exclusive)
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: SECOND_CUT + 500 });
    expect(marker.getAttribute("data-frame")).toBe(String(SECOND_CUT - 1));

    // past the left edge → clamped to 1 (exclusive of 0)
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: -50 });
    expect(marker.getAttribute("data-frame")).toBe("1");
    fireEvent.pointerUp(marker, { pointerId: 1 });

    // still strictly increasing overall, and the scene list follows
    marker = screen.getAllByTestId("cut-marker")[0];
    const frames = markerFrames();
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
    expect(
      screen.getAllByTestId("scene-card")[0].getAttribute("data-end"),
    ).toBe("1");
    expect(screen.getByTestId("dirty-indicator")).toBeTruthy();

    // moves after pointerup are ignored (drag ended)
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 200 });
    expect(marker.getAttribute("data-frame")).toBe("1");
  });
});

describe("WorkspaceScreen — save & versioning", () => {
  it("Save cuts PATCHes {cuts, expect_version} and re-renders version+1", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);
    const bodies = capturePatchBodies();

    fireEvent.doubleClick(strip, { clientX: NEW_CUT });
    const expectedCuts = [...CUTS, NEW_CUT].sort((a, b) => a - b);

    fireEvent.click(screen.getByText("Save cuts"));
    await waitFor(() =>
      expect(screen.getByTestId("scenes-version").textContent).toBe(
        `v${SCENES_VERSION + 1}`,
      ),
    );
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      cuts: expectedCuts,
      expect_version: SCENES_VERSION,
    });

    // saved — dirty indicator cleared, markers keep the new cut
    expect(screen.queryByTestId("dirty-indicator")).toBeNull();
    expect(markerFrames()).toEqual(expectedCuts);
  });

  it("save button is disabled while the local list is pristine", async () => {
    await renderWorkspace();
    const save = screen.getByText("Save cuts") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("a 409 conflict shows the banner; Reload & reapply keeps local edits and saves against the new version", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);
    const bodies = capturePatchBodies();

    fireEvent.doubleClick(strip, { clientX: NEW_CUT }); // local edit (dirty)

    // concurrent editor bumps the server version behind the UI's back
    await bumpServerScenes([500, 1000]);

    fireEvent.click(screen.getByText("Save cuts"));
    await screen.findByTestId("conflict-banner");
    // still on the loaded version locally, edits intact
    expect(markerFrames()).toContain(NEW_CUT);

    fireEvent.click(screen.getByText("Reload & reapply"));
    await waitFor(() =>
      expect(screen.getByTestId("scenes-version").textContent).toBe(
        `v${SCENES_VERSION + 1}`,
      ),
    );
    expect(screen.queryByTestId("conflict-banner")).toBeNull();
    // local edits reapplied on top of the fresh version — still dirty
    expect(markerFrames()).toContain(NEW_CUT);
    expect(screen.getByTestId("dirty-indicator")).toBeTruthy();

    fireEvent.click(screen.getByText("Save cuts"));
    await waitFor(() =>
      expect(screen.getByTestId("scenes-version").textContent).toBe(
        `v${SCENES_VERSION + 2}`,
      ),
    );
    const last = bodies[bodies.length - 1];
    expect(last.expect_version).toBe(SCENES_VERSION + 1);
    expect(last.cuts).toContain(NEW_CUT);
  });

  it("Reset to detected restores the last-saved list", async () => {
    const strip = await renderWorkspace();
    mockStripRect(strip);
    zoomToFit(strip);

    fireEvent.doubleClick(strip, { clientX: NEW_CUT });
    fireEvent.click(
      screen
        .getAllByTestId("cut-marker")
        .find((m) => Number(m.getAttribute("data-frame")) === FIRST_CUT)!,
    );
    fireEvent.keyDown(window, { key: "Delete" }); // remove a DETECTED cut
    expect(markerFrames()).not.toEqual(CUTS);

    fireEvent.click(screen.getByText("Reset to detected"));
    expect(markerFrames()).toEqual(CUTS);
    expect(screen.queryByTestId("dirty-indicator")).toBeNull();
  });
});

describe("WorkspaceScreen — pages", () => {
  it("defaults to the Cut page and switches pages by click and number key", async () => {
    await renderWorkspace();
    expect(screen.getByTestId("tab-cut").getAttribute("aria-selected")).toBe(
      "true",
    );

    // click: Media page (source details + guide); the Cut EDITOR unmounts
    // (Media keeps a read-only timeline, so the filmstrip itself remains)
    fireEvent.click(screen.getByTestId("tab-media"));
    expect(screen.getByTestId("media-tab")).toBeTruthy();
    expect(screen.queryByText("Save cuts")).toBeNull();
    expect(screen.queryByTestId("scene-card")).toBeNull();
    expect(window.location.hash).toBe("#tab=media");

    // number keys: 3 = Depth, 5 = Deliver, 6 = History, 2 = back to Cut
    fireEvent.keyDown(window, { key: "3" });
    expect(screen.getByTestId("step-card-depth_preview")).toBeTruthy();
    fireEvent.keyDown(window, { key: "5" });
    expect(screen.getByTestId("step-card-production")).toBeTruthy();
    fireEvent.keyDown(window, { key: "6" });
    expect(screen.getByLabelText("Conversion history")).toBeTruthy();
    fireEvent.keyDown(window, { key: "2" });
    expect(screen.getByTestId("filmstrip")).toBeTruthy();
    expect(window.location.hash).toBe("#tab=cut");
  });

  it("Media page: read-only timeline at Fit — scrub + zoom work, NO cut markers, no add", async () => {
    await renderWorkspace();
    fireEvent.click(screen.getByTestId("tab-media"));

    // context view: starts at Fit (the Cut page starts fully zoomed in)
    const strip = screen.getByTestId("filmstrip");
    expect(strip.getAttribute("data-zoom")).toBe("1");
    mockStripRect(strip);

    // the read-only strip carries NO cut markers — cut furniture belongs
    // to the Cut page (the Source card still counts the cuts)
    expect(screen.queryAllByTestId("cut-marker")).toHaveLength(0);

    // click-scrub pauses and seeks the proxy frame-exactly
    fireEvent.click(screen.getByLabelText("Play preview"));
    fireEvent.click(strip, { clientX: 100 });
    expect(readout()).toBe(frameLabel(100, FPS));
    expect(previewVideo().currentTime).toBe(seekTimeForFrame(100, FPS));
    expect(screen.getByLabelText("Play preview")).toBeTruthy(); // paused

    // double-click adds nothing (editing lives on the Cut page)
    fireEvent.doubleClick(strip, { clientX: NEW_CUT });
    expect(screen.queryAllByTestId("cut-marker")).toHaveLength(0);
    expect(screen.queryByText("Save cuts")).toBeNull();

    // zooming stays available for closer inspection
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(strip.getAttribute("data-zoom")).toBe("2");
  });

  it("Media page: the transport keys work — the SAME shortcuts as the Cut page", async () => {
    await renderWorkspace();
    fireEvent.click(screen.getByTestId("tab-media"));
    expect(readout()).toBe(frameLabel(0, FPS));

    // ←/→ step exactly ±1 frame on the frame-exact proxy
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(readout()).toBe(frameLabel(1, FPS));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(readout()).toBe(frameLabel(0, FPS));

    // Shift-arrow steps ±1 timecode second
    const second = Math.round(FPS.num / FPS.den);
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(readout()).toBe(frameLabel(second, FPS));

    // Space toggles playback
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByLabelText("Pause preview")).toBeTruthy();
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByLabelText("Play preview")).toBeTruthy();
  });

  it("Media page: header + ⓘ Guide drawer with the pipeline guide that deep-links to other pages", async () => {
    await renderWorkspace();
    fireEvent.click(screen.getByTestId("tab-media"));

    // shared page header; the guide is NOT on the page body
    const header = screen.getByTestId("page-header");
    expect(within(header).getByRole("heading", { name: "Media" })).toBeTruthy();
    expect(screen.queryByText("How this works")).toBeNull();

    // the drawer carries the old guide card content
    fireEvent.click(screen.getByTestId("media-guide-button"));
    const drawer = screen.getByTestId("media-guide-drawer");
    expect(drawer.getAttribute("data-vaul-drawer-direction")).toBe("right");
    expect(within(drawer).getByText("How this works")).toBeTruthy();
    for (const step of ["Cut →", "Depth →", "Stereo →", "Deliver →"]) {
      expect(within(drawer).getByRole("button", { name: step })).toBeTruthy();
    }
    expect(
      within(drawer).getByText(/Previews are optional/),
    ).toBeTruthy();

    // guide links deep-link into the pipeline pages
    fireEvent.click(within(drawer).getByRole("button", { name: "Depth →" }));
    expect(screen.getByTestId("step-card-depth_preview")).toBeTruthy();
    expect(window.location.hash).toBe("#tab=depth");
  });

  it("History page: shared header with the support hint as its description", async () => {
    await renderWorkspace();
    fireEvent.click(screen.getByTestId("tab-history"));

    const header = screen.getByTestId("page-header");
    expect(
      within(header).getByRole("heading", { name: "History" }),
    ).toBeTruthy();
    expect(within(header).getByText(/quote it to support/)).toBeTruthy();
    expect(screen.getByLabelText("Conversion history")).toBeTruthy();
  });

  it("toggles the shortcuts sheet with ? and closes with Escape", async () => {
    await renderWorkspace();
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByTestId("shortcuts-sheet")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("shortcuts-sheet")).toBeNull();
  });

  it("renders the step page with the project and refetches on onProjectChanged", async () => {
    await renderWorkspace();
    fireEvent.click(screen.getByTestId("tab-deliver"));
    expect(screen.getByTestId("step-card-project").textContent).toBe(PID);

    // a concurrent save bumps the server; onProjectChanged must refetch it
    await bumpServerScenes([500, 1000]);
    fireEvent.click(screen.getByText("refresh project"));

    // back on the Cut page the editor adopts the fresh server cuts
    fireEvent.keyDown(window, { key: "2" });
    await waitFor(() =>
      expect(screen.getByTestId("scenes-version").textContent).toBe(
        `v${SCENES_VERSION + 1}`,
      ),
    );
    expect(markerFrames()).toEqual([500, 1000]);
  });
});
