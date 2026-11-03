/**
 * Lifelike pages against the stateful MSW gateway: the Deliver page's
 * qualities, formats, split prompt (preselected, sends split_max_seconds
 * 900, downloads as parts), the charge-timing line, the GPU wait in the
 * tracker, and the Preview page's ~5 s request from the chosen moment.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Conversion, Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { resetLimitsCache } from "@/lib/api/useLimits";
import { parseRational } from "@/lib/frames";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { billingStatusNote, ConversionTracker } from "./ConversionTracker";
import { LifelikeDeliverPanel, splitQuestion } from "./LifelikeDeliverPanel";
import { LifelikePreviewPanel, previewRange } from "./LifelikePreviewPanel";
import {
  qualitiesFor,
  qualityChoices,
  qualityChoiceText,
  qualityName,
} from "@/lib/glossary";

import { PRESET_ABOVE_SOURCE } from "./methods";
import { CHARGE_BEFORE_COPY } from "./QuoteView";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 30 }));

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
});
afterAll(() => server.close());

const FIXTURE = projectFixture as unknown as Project;
const PID = FIXTURE.project_id;

/** Make the seeded project Lifelike (optionally longer / smaller). */
function lifelikeProject(probe: Partial<Project["probe"]> = {}): Project {
  const p = mockDb.projects.get(PID)!;
  p.method = "lifelike";
  p.probe = { ...p.probe!, ...probe };
  return structuredClone({ ...p, conversions: [] });
}

/** Bodies POSTed to a path suffix, captured as they go out. */
function captureBodies(suffix: string): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(suffix)) {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
    }
  });
  return bodies;
}

function renderPanel(el: React.ReactElement) {
  return render(<AuthProvider>{el}</AuthProvider>);
}

describe("Lifelike qualities", () => {
  it("offers 1080p to 4K at or below the source, and always 1080p", () => {
    const labels = (w: number, h: number) =>
      qualitiesFor({ width: w, height: h }).map(qualityName);
    expect(labels(3840, 2160)).toEqual(["1080p", "1440p", "3K", "4K"]);
    expect(labels(2560, 1440)).toEqual(["1080p", "1440p"]);
    expect(labels(1080, 1920)).toEqual(["1080p"]); // portrait: short side
    expect(labels(1280, 720)).toEqual(["1080p"]);
  });

  it("Deliver shows only the qualities the source allows — no Draft", () => {
    const project = lifelikeProject({ width: 2560, height: 1440 });
    renderPanel(
      <LifelikeDeliverPanel project={project} onProjectChanged={() => {}} />,
    );
    const tiles = within(screen.getByRole("radiogroup", { name: "Quality" }));
    expect(tiles.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByTestId("quality-1080p").textContent).toMatch(
      /^1080p1920×1080 per eye/,
    );
    expect(screen.getByTestId("quality-qhd").textContent).toMatch(
      /^1440p2560×1440 per eye/,
    );
    // the best one is preselected
    expect((tiles.getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
  });

  it("prices every quality tile for this video, and the button carries the price (S3D-45)", async () => {
    renderPanel(
      <LifelikeDeliverPanel project={lifelikeProject()} onProjectChanged={() => {}} />,
    );
    for (const p of ["1080p", "qhd", "3k", "4k"]) {
      await waitFor(() =>
        expect(screen.getByTestId(`quality-price-${p}`).textContent).toMatch(
          /^\$\d+\.\d\d$/,
        ),
      );
    }
    const top = screen.getByTestId("quality-price-4k").textContent!;
    await waitFor(() =>
      expect(screen.getByTestId("checkout-main").textContent).toBe(`Make 3D · ${top}`),
    );
    // the quote's lines show in the price card, no Get quote step
    expect(screen.getByTestId("quote-total").textContent).toBe(top);
    expect(screen.queryByRole("button", { name: "Get quote" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "?" }));
    expect(screen.getByRole("dialog").textContent).toMatch(/first minute/);
  });

  it("names the real size: Full resolution between steps and below 1080 (S3D-04)", () => {
    // a 720p source: one option, its own size, at the 1080p price
    expect(
      qualityChoices({ probe: { ...FIXTURE.probe!, width: 1280, height: 720 } }).map(
        qualityChoiceText,
      ),
    ).toEqual(["Full resolution (720p) · 1280×720 per eye"]);
    // the gateway's list wins (a 2.39:1 4K source)
    expect(
      qualityChoices({
        qualities: [
          { preset: "1080p", label: "1080p", eye_width: 2582, eye_height: 1080 },
          { preset: "qhd", label: "1440p", eye_width: 3442, eye_height: 1440 },
          {
            preset: "3k",
            label: "Full resolution (1606p)",
            eye_width: 3840,
            eye_height: 1606,
            price_preset: "qhd",
          },
        ],
      }).map(qualityChoiceText),
    ).toEqual([
      "1080p · 2582×1080 per eye",
      "1440p · 3442×1440 per eye",
      "Full resolution (1606p) · 3840×1606 per eye",
    ]);
    // copy rule: sizes only, nothing above 4K
    for (const q of qualityChoices({ probe: FIXTURE.probe })) {
      expect(qualityChoiceText(q)).not.toMatch(/detail|sharp|8K|6K/i);
    }
  });

  it("a preset above the source reads as a friendly message", async () => {
    const project = lifelikeProject();
    // the gateway's probe disagrees with the page (e.g. stale project)
    mockDb.projects.get(PID)!.probe = {
      ...mockDb.projects.get(PID)!.probe!,
      width: 1280,
      height: 720,
    };
    renderPanel(
      <LifelikeDeliverPanel project={project} onProjectChanged={() => {}} />,
    );
    // the best quality (4K) is preselected and priced right away
    expect(await screen.findByText(PRESET_ABOVE_SOURCE)).toBeTruthy();
  });
});

describe("Lifelike Deliver", () => {
  it("offers only the Lifelike formats", () => {
    renderPanel(
      <LifelikeDeliverPanel
        project={lifelikeProject()}
        onProjectChanged={() => {}}
      />,
    );
    const files = within(screen.getByRole("group", { name: "Files you'll get" }));
    expect(files.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Vision Pro spatial video",
      "Side by side",
      "Side by side (half size)",
    ]);
    // Vision Pro + Side by side by default (the Overview's "You'll get")
    expect(
      files.getAllByRole("checkbox").map((c) => (c as HTMLInputElement).checked),
    ).toEqual([true, true, false]);
    expect(screen.queryByText(/anaglyph|top.?bottom|red.?cyan/i)).toBeNull();
    // none of Classic's knobs
    expect(screen.queryByText(/Edge style|Start from scratch|Inherited/)).toBeNull();
  });

  it("Where will you watch it? picks the files (S3D-07), and Which part? trims the run (S3D-10)", async () => {
    const project = lifelikeProject();
    const quotes = captureBodies("/quotes");
    renderPanel(<LifelikeDeliverPanel project={project} onProjectChanged={() => {}} />);
    const watch = within(screen.getByRole("group", { name: "Where will you watch it?" }));
    const files = within(screen.getByRole("group", { name: "Files you'll get" }));
    const checked = () =>
      files
        .getAllByRole("checkbox")
        .filter((c) => (c as HTMLInputElement).checked)
        .map((c) => c.getAttribute("aria-label"));
    fireEvent.click(watch.getByLabelText("3D TV or projector"));
    expect(checked()).toEqual(["Side by side (half size)"]);
    fireEvent.click(watch.getByLabelText("Apple Vision Pro"));
    expect(checked()).toEqual(["Vision Pro spatial video", "Side by side (half size)"]);
    fireEvent.click(watch.getByLabelText("3D TV or projector"));
    fireEvent.click(watch.getByLabelText("Apple Vision Pro"));
    fireEvent.click(watch.getByLabelText("Not sure"));
    expect(checked()).toEqual(["Vision Pro spatial video", "Side by side"]);

    expect(screen.getByTestId("trim-chip").textContent).toMatch(/^Whole video · \d+:\d\d$/);
    const start = screen.getByLabelText("Start") as HTMLInputElement;
    expect(start.value).toBe("0:00");
    fireEvent.change(start, { target: { value: "0:10" } });
    fireEvent.blur(start);
    expect(screen.getByTestId("trim-chip").textContent).toMatch(/^Part · /);
    await waitFor(() =>
      expect(quotes.some((q) => q.step === "production" && q.from_frame === 240)).toBe(true),
    );
  });

  it("asks to split a long video (preselected), sends 900 s parts, waits for a GPU, and lists parts", async () => {
    const fps = parseRational(FIXTURE.probe!.fps_rational);
    const seconds = 1800;
    const project = lifelikeProject({
      duration_s: seconds,
      num_frames: (seconds * fps.num) / fps.den,
    });
    const sent = captureBodies("/conversions");
    renderPanel(
      <LifelikeDeliverPanel project={project} onProjectChanged={() => {}} />,
    );
    const prompt = await screen.findByTestId("split-prompt");
    expect(within(prompt).getByText(splitQuestion(seconds))).toBeTruthy();
    expect(splitQuestion(seconds)).toBe(
      "Your video is 30 minutes long. Split it into 15-minute parts so each file plays smoothly?",
    );
    const split = within(prompt).getByRole("radio", { name: /^Split into parts/ }) as HTMLInputElement;
    expect(split.checked).toBe(true);
    expect(prompt.textContent).toContain("2 parts: about 15 and 15 min");
    expect(prompt.textContent).toContain("Parts end at a scene change. No extra charge.");
    // a 30-minute run is quoted above the threshold: paid up front
    expect(screen.getByTestId("charge-timing-hint").textContent).toBe(
      CHARGE_BEFORE_COPY,
    );

    mockDb.gpuWaitPolls = 1_000; // hold the GPU wait until we've seen it
    fireEvent.click(screen.getByTestId("checkout-main"));
    expect(
      await screen.findByTestId("waiting-for-gpu", {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    mockDb.gpuWaitPolls = 0;

    // one group per device, a row per part (screen 08)
    const group = await screen.findByTestId("file-group-mvhevc", {}, { timeout: 5000 });
    expect(within(group).getByText("Apple Vision Pro")).toBeTruthy();
    expect(within(group).getByText("Part 1")).toBeTruthy();
    expect(within(group).getByText("Part 2")).toBeTruthy();
    expect(screen.getByTestId("view-in-3d").textContent).toBe("Full screen");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      step: "production",
      split_max_seconds: 900,
      formats: ["mvhevc", "sbs"],
    });
  });

  it("keeps one file when the user says so", async () => {
    const project = lifelikeProject({ duration_s: 1800, num_frames: 43200 });
    const sent = captureBodies("/conversions");
    renderPanel(
      <LifelikeDeliverPanel project={project} onProjectChanged={() => {}} />,
    );
    fireEvent.click(await screen.findByLabelText("Keep as one file"));
    fireEvent.click(screen.getByTestId("checkout-main"));
    await screen.findByTestId("conversion-tracker");
    expect(sent[0].split_max_seconds).toBeUndefined();
  });

  it("does not ask for a short video", async () => {
    renderPanel(
      <LifelikeDeliverPanel
        project={lifelikeProject()}
        onProjectChanged={() => {}}
      />,
    );
    await screen.findByTestId("quote-breakdown");
    expect(screen.queryByTestId("split-prompt")).toBeNull();
    // a small run is charged after it's done (S3D-19, S3D-21)
    expect(screen.getByTestId("charge-timing-hint").textContent).toBe(
      "Charged after it's done.",
    );
  });
});

describe("Lifelike Preview", () => {
  it("previewRange spans ~5 s from the moment, shifted back near the end", () => {
    const fps = { num: 24, den: 1 };
    expect(previewRange(100, 1000, fps)).toEqual([100, 220]);
    expect(previewRange(950, 1000, fps)).toEqual([880, 1000]);
    expect(previewRange(0, 50, fps)).toEqual([0, 50]);
  });

  it("prices as you pick (one button), runs from the playhead, and checks the 3D on this screen (S3D-13, S3D-32, S3D-45)", async () => {
    const project = lifelikeProject();
    const quotes = captureBodies("/quotes");
    const runs = captureBodies("/conversions");
    renderPanel(
      <LifelikePreviewPanel project={project} onProjectChanged={() => {}} />,
    );
    // the best quality the video reaches comes preselected (the Overview
    // prices that preview)
    const quality = within(screen.getByRole("radiogroup", { name: "Quality" }));
    const options = quality.getAllByRole("radio");
    expect(options.at(-1)!.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Get quote" })).toBeNull();
    // no preview yet
    expect(screen.getByTestId("preview-empty")).toBeTruthy();

    fireEvent.click(quality.getByRole("radio", { name: "1080p" }));
    // priced per frame like the final: 5 s at 1080p 24 fps is under the
    // minimum, so the minimum applies — the price sits on the button
    const main = await screen.findByTestId("checkout-main");
    await waitFor(() =>
      expect(main.textContent).toBe("Preview this moment · $0.50"),
    );
    expect(screen.getByTestId("charge-timing-hint").textContent).toBe(
      "Charged after it's done.",
    );
    // details behind the "?"
    expect(screen.queryByTestId("quote-breakdown")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "?" }));
    const pop = within(screen.getByRole("dialog"));
    expect(pop.getByText(/120 frames at the 1080p rate/)).toBeTruthy();
    expect(pop.getByText(/Minimum charge \$0\.50/, { selector: "span" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(quotes.at(-1)).toMatchObject({
      step: "lifelike_preview",
      preset: "1080p",
      formats: ["sbs"],
      from_frame: 0,
      to_frame: 120,
    });

    // Quick look: half the frame rate
    fireEvent.click(screen.getByLabelText(/Quick look/));
    await waitFor(() => expect(quotes.at(-1)).toMatchObject({ target_fps: 12 }));
    fireEvent.click(screen.getByLabelText(/Quick look/));

    // 2–10 s, 5 by default
    expect(screen.getByTestId("preview-length").textContent).toBe("5 s");
    fireEvent.click(screen.getByRole("button", { name: "Longer" }));
    expect(screen.getByTestId("preview-length").textContent).toBe("6 s");
    fireEvent.click(screen.getByRole("button", { name: "Shorter" }));
    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Shorter" }));
    }
    expect(screen.getByTestId("preview-length").textContent).toBe("2 s");
    expect(
      (screen.getByRole("button", { name: "Shorter" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Longer" }));
    }
    expect(screen.getByTestId("preview-length").textContent).toBe("5 s");

    // the box on the timeline follows the playhead
    expect(screen.getByTestId("timeline-range")).toBeTruthy();

    // one click runs it
    await waitFor(() =>
      expect(screen.getByTestId("checkout-main").textContent).toMatch(/\$0\.50$/),
    );
    fireEvent.click(screen.getByTestId("checkout-main"));
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({
      step: "lifelike_preview",
      preset: "1080p",
      from_frame: 0,
      to_frame: 120,
    });
  });

  it("shows the latest preview with a free Side by side / Red-cyan / Wiggle check", async () => {
    const project = lifelikeProject();
    project.conversions = [
      {
        conversion_id: "c0000preview",
        state: "succeeded",
        kind: "video",
        project_id: PID,
        step: "lifelike_preview",
        method: "lifelike",
        params: { preset: "1080p", formats: ["sbs"], from_frame: 24, to_frame: 144 },
        quote: { amount_cents: 50, currency: "usd" },
        progress: 1,
        outputs: ["sbs"],
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
      } as Conversion,
    ];
    mockDb.conversions.set("c0000preview", project.conversions[0]);
    renderPanel(
      <LifelikePreviewPanel project={project} onProjectChanged={() => {}} />,
    );
    const check = await screen.findByTestId("stereo-check");
    expect(check.getAttribute("data-mode")).toBe("sbs");
    expect(screen.getByTestId("preview-shown-meta").textContent).toBe(
      "0:01 – 0:06 · 1080p",
    );
    const view = within(screen.getByRole("radiogroup", { name: "View" }));
    fireEvent.click(view.getByRole("radio", { name: "Red-cyan" }));
    expect(screen.getByTestId("stereo-check").getAttribute("data-mode")).toBe(
      "anaglyph",
    );
    expect(screen.getByLabelText("Red-cyan view")).toBeTruthy();
    fireEvent.click(view.getByRole("radio", { name: "Wiggle" }));
    expect(screen.getByLabelText("Wiggle view")).toBeTruthy();
    expect(screen.getByText("Free 3D check on this screen")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Make the whole video in 3D" }).getAttribute("href"),
    ).toBe("#tab=make");
  });
});

describe("ConversionTracker GPU wait", () => {
  function run(over: Partial<Conversion> = {}): Conversion {
    return {
      conversion_id: "c0000000wait",
      state: "processing",
      kind: "video",
      params: {} as Conversion["params"],
      project_id: PID,
      step: "production",
      quote: { amount_cents: 900, currency: "usd" },
      progress: 0.4,
      stage: "render",
      eta_seconds: 300,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...over,
    };
  }

  it("says it is waiting in line — no stage, no time left, no bar", () => {
    render(
      <AuthProvider>
        <ConversionTracker
          conversion={run({ waiting_for_gpu: true, stage: "queued" })}
          onProjectChanged={() => {}}
        />
      </AuthProvider>,
    );
    expect(screen.getByTestId("run-status").textContent).toBe("Waiting in line");
    expect(screen.getByTestId("waiting-for-gpu").textContent).toBe(
      "Starts as soon as a machine is free, usually within minutes. The price stays the same.",
    );
    expect(screen.queryByText("Waiting to start")).toBeNull();
    expect(screen.queryByTestId("tracker-eta")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows the Lifelike stage in plain words with the run's time left", () => {
    render(
      <AuthProvider>
        <ConversionTracker conversion={run()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    expect(screen.getByTestId("run-status").textContent).toBe("Making your 3D");
    // three plain steps; the current one names the stage
    const steps = screen.getByTestId("tracker-steps");
    expect(steps.textContent).toContain("Getting ready");
    expect(steps.textContent).toContain("Making the 3D video");
    expect(steps.textContent).toContain("Saving your files");
    expect(
      steps.querySelector('[aria-current="step"]')!.textContent,
    ).toContain("Making the 3D video · Rendering in 3D");
    expect(screen.getByTestId("tracker-eta").textContent).toBe("about 5 min left");
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("falls back to the quote's estimate until the run reports one", () => {
    render(
      <AuthProvider>
        <ConversionTracker
          conversion={run({ eta_seconds: 0 })}
          estimateSeconds={600}
          onProjectChanged={() => {}}
        />
      </AuthProvider>,
    );
    expect(screen.getByTestId("tracker-eta").textContent).toMatch(/10 min/);
  });

  it("promises the refund on a failed pre-paid run", () => {
    render(
      <AuthProvider>
        <ConversionTracker
          conversion={run({
            state: "failed",
            charge_timing: "before",
            error: { code: "x", message: "Something went wrong." },
          })}
          onProjectChanged={() => {}}
        />
      </AuthProvider>,
    );
    expect(screen.getByTestId("billing-note").textContent).toMatch(
      /refunded in full/,
    );
  });

  it("says plainly what happened to a pre-charged run's payment", () => {
    const pre = run({ charge_timing: "before" });
    expect(billingStatusNote({ ...pre, billing: { status: "charged" } })).toBe(
      "Paid when the run started. Refunded in full if it fails.",
    );
    expect(
      billingStatusNote({ ...pre, state: "failed", billing: { status: "refund_pending" } }),
    ).toMatch(/refund is on its way/);
    expect(
      billingStatusNote({ ...pre, state: "failed", billing: { status: "refunded" } }),
    ).toBe("Refunded in full.");
    expect(
      billingStatusNote({ ...pre, state: "canceled", billing: { status: "not_charged" } }),
    ).toBe("You were not charged.");
    expect(billingStatusNote(run())).toBeNull(); // billed after, as today
  });

  it("a pre-charged run waits for the card payment before it starts", () => {
    render(
      <AuthProvider>
        <ConversionTracker
          conversion={run({
            state: "created",
            charge_timing: "before",
            billing: { status: "charge_pending" },
          })}
          onProjectChanged={() => {}}
        />
      </AuthProvider>,
    );
    expect(screen.getByTestId("hold-confirming").textContent).toMatch(
      /Confirming the payment with your bank/,
    );
  });
});

describe("in a headset browser (S3D-47)", () => {
  const QUEST =
    "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.1.0.0 Chrome/126.0.0.0 VR Safari/537.36";
  afterEach(() => vi.restoreAllMocks());

  it("previews ask for the headset's own format", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(QUEST);
    const quotes = captureBodies("/quotes");
    renderPanel(
      <LifelikePreviewPanel project={lifelikeProject()} onProjectChanged={() => {}} />,
    );
    await waitFor(() =>
      expect(quotes.some((q) => q.step === "lifelike_preview")).toBe(true),
    );
    expect(quotes.find((q) => q.step === "lifelike_preview")).toMatchObject({
      formats: ["half_sbs"],
    });
  });

  it("Where will you watch it? preselects the headset", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(QUEST);
    renderPanel(
      <LifelikeDeliverPanel project={lifelikeProject()} onProjectChanged={() => {}} />,
    );
    const watch = within(screen.getByRole("group", { name: "Where will you watch it?" }));
    expect((watch.getByLabelText("Meta Quest") as HTMLInputElement).checked).toBe(true);
    const files = within(screen.getByRole("group", { name: "Files you'll get" }));
    expect(
      files
        .getAllByRole("checkbox")
        .filter((c) => (c as HTMLInputElement).checked)
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["Side by side (half size)"]);
  });
});

describe("Lifelike sizes above 4K and Advanced (S3D-48/49/50)", () => {
  it("offers 5K, 6K and 8K when the gateway lists them", async () => {
    const project = lifelikeProject({ width: 7680, height: 4320 });
    renderPanel(<LifelikeDeliverPanel project={project} onProjectChanged={() => {}} />);
    const tiles = within(screen.getByRole("radiogroup", { name: "Quality" }));
    // the fixture project has no gateway list: the page offers up to 4K
    expect(tiles.getAllByRole("radio")).toHaveLength(4);
    cleanup();
    const listed = {
      ...project,
      qualities: [
        { preset: "4k" as const, label: "4K", eye_width: 3840, eye_height: 2160 },
        { preset: "5k" as const, label: "5K", eye_width: 5120, eye_height: 2880 },
        { preset: "6k" as const, label: "6K", eye_width: 5760, eye_height: 3240 },
        { preset: "8k" as const, label: "8K", eye_width: 7680, eye_height: 4320 },
      ],
    };
    mockDb.projects.get(PID)!.probe = { ...mockDb.projects.get(PID)!.probe!, width: 7680, height: 4320 };
    renderPanel(<LifelikeDeliverPanel project={listed} onProjectChanged={() => {}} />);
    expect(screen.getByTestId("quality-8k").textContent).toMatch(/^8K7680×4320 per eye/);
    await waitFor(() =>
      expect(screen.getByTestId("quality-price-8k").textContent).toMatch(/^\$\d+\.\d\d$/),
    );
  });

  it("Advanced stays collapsed; Keep the original picture in one eye sends original_eye", async () => {
    const quotes = captureBodies("/quotes");
    renderPanel(
      <LifelikeDeliverPanel project={lifelikeProject()} onProjectChanged={() => {}} />,
    );
    const advanced = screen.getByTestId("lifelike-advanced") as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    const keep = within(advanced).getByLabelText("Keep the original picture in one eye") as HTMLInputElement;
    expect(keep.checked).toBe(false);
    // Sharper centre is hidden unless the gateway offers it
    expect(within(advanced).queryByText(/Sharper centre/)).toBeNull();
    fireEvent.click(keep);
    fireEvent.click(within(advanced).getByLabelText("Right"));
    await waitFor(() =>
      expect(
        quotes.some((q) => q.step === "production" && q.original_eye === "right" && q.preset === "4k"),
      ).toBe(true),
    );
  });

  it("Sharper centre appears only below the video's own size when the gateway offers it", async () => {
    mockDb.lifelikeFoveation = true;
    resetLimitsCache();
    const quotes = captureBodies("/quotes");
    renderPanel(
      <LifelikeDeliverPanel project={lifelikeProject()} onProjectChanged={() => {}} />,
    );
    const advanced = screen.getByTestId("lifelike-advanced");
    // 4K source at 4K: the video's own size — not offered
    await new Promise((r) => setTimeout(r, 50));
    expect(within(advanced).queryByText(/Sharper centre/)).toBeNull();
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Quality" })).getAllByRole("radio")[0],
    );
    const sharper = await within(advanced).findByLabelText(/Sharper centre/);
    fireEvent.click(sharper);
    await waitFor(() =>
      expect(
        quotes.some((q) => q.step === "production" && q.foveation === "static" && q.preset === "1080p"),
      ).toBe(true),
    );
  });
});

describe("Where will you watch it? options (S3D-51)", () => {
  it("lists the devices in order, each picking its files", () => {
    renderPanel(
      <LifelikeDeliverPanel project={lifelikeProject()} onProjectChanged={() => {}} />,
    );
    const watch = within(screen.getByRole("group", { name: "Where will you watch it?" }));
    expect(watch.getAllByRole("checkbox").map((c) => c.closest("label")!.textContent)).toEqual([
      "Apple Vision Pro",
      "Samsung Galaxy XR",
      "Meta Quest",
      "Pico",
      "Steam Frame",
      "XR glasses (XREAL, VITURE, RayNeo)",
      "3D TV or projector",
      "Not sure",
    ]);
    const files = within(screen.getByRole("group", { name: "Files you'll get" }));
    const checked = () =>
      files
        .getAllByRole("checkbox")
        .filter((c) => (c as HTMLInputElement).checked)
        .map((c) => c.getAttribute("aria-label"));
    const only = (label: string) => {
      // clear, then pick one
      for (const c of watch.getAllByRole("checkbox")) {
        if ((c as HTMLInputElement).checked) fireEvent.click(c);
      }
      fireEvent.click(watch.getByLabelText(label));
      return checked();
    };
    expect(only("Apple Vision Pro")).toEqual(["Vision Pro spatial video"]);
    expect(only("Samsung Galaxy XR")).toEqual(["Side by side"]);
    expect(only("Meta Quest")).toEqual(["Side by side (half size)"]);
    expect(only("Pico")).toEqual(["Side by side"]);
    expect(only("Steam Frame")).toEqual(["Side by side"]);
    expect(only("XR glasses (XREAL, VITURE, RayNeo)")).toEqual(["Side by side"]);
    expect(only("3D TV or projector")).toEqual(["Side by side (half size)"]);
    expect(only("Not sure")).toEqual(["Vision Pro spatial video", "Side by side"]);
  });
});
