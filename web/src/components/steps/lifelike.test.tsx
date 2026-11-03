/**
 * Lifelike pages against the stateful MSW gateway: the Deliver page's
 * qualities, formats, split prompt (preselected, sends split_max_seconds
 * 900, downloads as parts), the charge-timing line, the GPU wait in the
 * tracker, and the Preview page's ~5 s request from the chosen moment.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
import { parseRational } from "@/lib/frames";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { billingStatusNote, ConversionTracker } from "./ConversionTracker";
import { LifelikeDeliverPanel, splitQuestion } from "./LifelikeDeliverPanel";
import { LifelikePreviewPanel, previewRange } from "./LifelikePreviewPanel";
import { qualitiesFor, qualityName } from "@/lib/glossary";

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
    const select = screen.getByLabelText("Quality") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "1080p",
      "1440p",
    ]);
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
    fireEvent.change(screen.getByLabelText("Quality"), {
      target: { value: "4k" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Get quote" }));
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
    for (const name of [
      "Vision Pro spatial video",
      "Side by side",
      "Side by side (half size)",
    ]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
    expect(screen.queryByText(/anaglyph|top.?bottom|red.?cyan/i)).toBeNull();
    // none of Classic's knobs
    expect(screen.queryByText(/Edge handling|Start from scratch|Inherited/)).toBeNull();
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
    expect(screen.queryByTestId("split-prompt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Get quote" }));

    const prompt = await screen.findByTestId("split-prompt");
    expect(within(prompt).getByText(splitQuestion(seconds))).toBeTruthy();
    expect(splitQuestion(seconds)).toBe(
      "This video is 30 minutes long. Split it into 15-minute parts so each file plays smoothly?",
    );
    const split = within(prompt).getByLabelText("Split into parts") as HTMLInputElement;
    expect(split.checked).toBe(true);
    // a 30-minute run is quoted above the threshold: paid up front
    expect((await screen.findByTestId("quote-charge-timing")).textContent).toBe(
      CHARGE_BEFORE_COPY,
    );

    mockDb.gpuWaitPolls = 1_000; // hold the GPU wait until we've seen it
    fireEvent.click(screen.getByRole("button", { name: /^Convert/ }));
    expect(
      await screen.findByTestId("waiting-for-gpu", {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    mockDb.gpuWaitPolls = 0;

    expect(
      await screen.findByText("Vision Pro spatial video · Part 2", {}, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getByText("Vision Pro spatial video · Part 1")).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      step: "production",
      split_max_seconds: 900,
      formats: ["mvhevc", "half_sbs"],
    });
  });

  it("keeps one file when the user says so", async () => {
    const project = lifelikeProject({ duration_s: 1800, num_frames: 43200 });
    const sent = captureBodies("/conversions");
    renderPanel(
      <LifelikeDeliverPanel project={project} onProjectChanged={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Get quote" }));
    fireEvent.click(await screen.findByLabelText("Keep as one file"));
    fireEvent.click(screen.getByRole("button", { name: /^Convert/ }));
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
    fireEvent.click(screen.getByRole("button", { name: "Get quote" }));
    await screen.findByTestId("quote-breakdown");
    expect(screen.queryByTestId("split-prompt")).toBeNull();
    expect(screen.queryByTestId("quote-charge-timing")).toBeNull();
    expect(screen.getByTestId("charge-timing-hint").textContent).toMatch(
      /when it succeeds/,
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

  it("quotes and runs ~5 s from the chosen moment at the chosen quality", async () => {
    const project = lifelikeProject();
    const quotes = captureBodies("/quotes");
    renderPanel(
      <LifelikePreviewPanel project={project} onProjectChanged={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Get quote" }));
    // a 5-second 1080p preview is at the $0.50 minimum
    expect((await screen.findByTestId("quote-total")).textContent).toBe("$0.50");
    fireEvent.change(screen.getByLabelText("Quality"), {
      target: { value: "qhd" },
    });
    expect(screen.queryByTestId("quote-total")).toBeNull(); // re-quote needed
    fireEvent.click(screen.getByRole("button", { name: "Get quote" }));
    await screen.findByTestId("quote-total");
    expect(quotes[1]).toMatchObject({
      step: "lifelike_preview",
      preset: "qhd",
      formats: ["sbs"],
      from_frame: 0,
      to_frame: 120,
    });
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
    expect(screen.getByText("Rendering in 3D")).toBeTruthy();
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
