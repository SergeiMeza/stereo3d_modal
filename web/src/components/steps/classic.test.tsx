/**
 * Classic 3D stays a live, supported production path (owner 2026-11-07):
 * its bitrate list (Automatic, Match the source, 40/60/100) and prices,
 * no File quality scale. This walks a Classic project through every
 * surface the Lifelike web work touched: the Make 3D quote and start,
 * progress on Overview from the live feed and from the slow poll, Files
 * download and Get another format, the Details panel, Previous runs,
 * the preview strip, Billing history and the price rows, and the launch
 * offer once the gateway sends it on a Classic quote. Mock server only.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, type JSX } from "react";

import { BillingScreen } from "@/components/billing/BillingScreen";
import { OverviewSteps, useOverviewSteps } from "@/components/workspace/OverviewSteps";
import type { Conversion, Project, StepConversionRequest, StepQuoteResponse } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { parseLiveEvent } from "@/lib/live/events";
import { resetLiveHubForTests, retainOpenProject, setLiveOptionsForTests } from "@/lib/live/hub";
import { applyLiveEvent } from "@/lib/live/liveStore";
import { appStore } from "@/lib/state/stores";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { DeliverPanel } from "./DeliverPanel";
import { HistoryList } from "./HistoryList";
import { BITRATES, bitrateField } from "./makeControls";
import { PreviousRuns } from "./PreviousRuns";
import { QuoteView } from "./QuoteView";
import { detailRows } from "./RunDetails";
import { StereoPanel } from "./StereoPanel";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 40 }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/x",
}));

beforeAll(() => {
  HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("pause"));
  };
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  act(() => clearStepQuotes());
  resetLiveHubForTests();
  resetPricingCache();
  mockDb.reset();
  window.localStorage.clear();
});
afterAll(() => server.close());

const FIXTURE = projectFixture as unknown as Project;
const PID = FIXTURE.project_id;

/** The fixture as a Classic project (no method: Classic, as before 2026-11). */
function classicProject(over: Partial<Project> = {}): Project {
  const p = structuredClone(projectFixture) as unknown as Project;
  delete (p as { method?: string }).method;
  return { ...p, ...over };
}

/** A finished Classic full run, as the gateway lists it: no quality, no
 * foveation, no express, no Lifelike-only fields. */
function classicRun(over: Partial<Conversion> = {}): Conversion {
  const c = {
    conversion_id: "classic_run_1",
    state: "succeeded",
    kind: "video",
    project_id: PID,
    step: "production",
    method: "classic",
    params: { preset: "4k", formats: ["mvhevc", "half_sbs"], inpaint: "propainter", depth_res: 1442, depth_scale: 1.1 },
    quote: {
      amount_cents: 4972,
      currency: "usd",
      breakdown: { step: "production", preset: "4k", subtotal_cents: 5524, discount_cents: 552, reuse_discount_cents: 0 },
    },
    progress: 1,
    outputs: ["mvhevc", "half_sbs"],
    billing: { status: "charged", charged_cents: 4972 },
    created_at: "2026-11-05T09:00:00Z",
    updated_at: "2026-11-05T09:40:00Z",
    ...over,
  } as Conversion;
  mockDb.conversions.set(c.conversion_id, structuredClone(c));
  return c;
}

function captureBodies(path: string): StepConversionRequest[] {
  const out: StepConversionRequest[] = [];
  server.events.on("request:start", ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(path)) {
      void request
        .clone()
        .json()
        .then((b) => out.push(b as StepConversionRequest));
    }
  });
  return out;
}

const LIFELIKE_ONLY = ["quality", "foveation", "express", "quick_look", "original_eye", "master"];
const LIFELIKE_ROWS = ["File quality", "Foveated Detail", "Express", "Quick look", "Intro", "Free previews used", "Launch offer"];

describe("Classic Make 3D: quote and start", () => {
  it("quotes with the bitrate list, starts with no Lifelike fields, and the tracker follows the run", async () => {
    const quotes = captureBodies("/quotes");
    const starts = captureBodies("/conversions");
    const project = classicProject();
    mockDb.projects.get(PID)!.method = undefined;
    render(
      <AuthProvider>
        <DeliverPanel project={project} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    await screen.findByTestId("quote-breakdown", {}, { timeout: 3000 });
    // the bitrate list stays: Automatic, Match the source, 40/60/100
    (screen.getByTestId("classic-advanced") as HTMLDetailsElement).open = true;
    const select = screen.getByLabelText("Bitrate") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Automatic",
      "Match the source",
      "40 Mbit/s",
      "60 Mbit/s",
      "100 Mbit/s",
    ]);
    // no File quality scale, no Foveated or Express on Classic
    expect(screen.queryByTestId("file-quality")).toBeNull();
    expect(screen.queryByTestId("addon-express")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Foveated|File quality|launch offer/i);
    fireEvent.change(select, { target: { value: "60" } });
    await waitFor(() => expect(quotes.some((b) => b.step === "production" && b.bitrate === 60)).toBe(true));
    await waitFor(() => expect(screen.getByTestId("checkout-main").textContent).toMatch(/^Make 3D · \$\d+\.\d\d$/));
    fireEvent.click(screen.getByTestId("checkout-main"));
    await screen.findByTestId("conversion-tracker", {}, { timeout: 3000 });
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toMatchObject({ step: "production", bitrate: 60 });
    for (const k of LIFELIKE_ONLY) expect(starts[0]).not.toHaveProperty(k);
    // the run is made and its files listed (the mock's Classic stages)
    await screen.findByTestId("file-group-mvhevc", {}, { timeout: 8000 });
  }, 20_000);
});

describe("Classic progress on Overview", () => {
  /** Overview inside the project page, which holds the project open (the
   * slow poll reads it again), as WorkspaceScreen does. */
  function Overview({ project }: { project: Project }): JSX.Element {
    useEffect(() => retainOpenProject(project.project_id), [project.project_id]);
    return <OverviewSteps steps={useOverviewSteps(project)} onNavigate={() => {}} />;
  }
  const makeStep = () => {
    const s = screen.getByTestId("step-make");
    return `${s.getAttribute("data-state")}:${within(s).queryByTestId("step-status")?.textContent ?? ""}`;
  };

  it("follows the live feed: the Classic flow's steps, making %, then Files", () => {
    mockDb.eventsDown = true;
    const run = classicRun({ state: "paid", progress: 0, outputs: undefined, billing: undefined });
    render(
      <AuthProvider>
        <Overview project={classicProject({ conversions: [run] })} />
      </AuthProvider>,
    );
    // Classic's own flow: Depth and 3D look, no Preview
    expect(screen.getByTestId("step-depth")).toBeTruthy();
    expect(screen.getByTestId("step-look")).toBeTruthy();
    expect(screen.queryByTestId("step-preview")).toBeNull();
    expect(makeStep()).toBe("current:Waiting in line");
    let seq = 0;
    const send = (event: string, data: Record<string, unknown>) => {
      seq += 1;
      const ev = parseLiveEvent(event, JSON.stringify({ type: event, ...data }), String(seq));
      act(() => applyLiveEvent(appStore, ev!));
    };
    const v = (s: number) => (Date.parse("2026-11-07T08:00:00Z") + s * 1000) * 1000;
    send("run.progress", { run_id: run.conversion_id, project_id: PID, version: v(1), state: "processing", progress: 0.35, stage: "depth" });
    expect(makeStep()).toBe("current:Making… 35%");
    send("run.state", {
      run_id: run.conversion_id,
      project_id: PID,
      version: v(2),
      state: "succeeded",
      run: { ...run, state: "succeeded", progress: 1, outputs: ["mvhevc", "half_sbs"] },
    });
    expect(makeStep()).toBe("done:");
    expect(screen.getByTestId("step-files").getAttribute("data-state")).toBe("current");
  });

  it("with the stream down, the slow poll moves it along", async () => {
    mockDb.eventsDown = true;
    setLiveOptionsForTests({ fallbackMs: 60, random: () => 0 });
    const run = classicRun({ state: "paid", progress: 0, outputs: undefined, billing: undefined });
    render(
      <AuthProvider>
        <Overview project={classicProject({ conversions: [run] })} />
      </AuthProvider>,
    );
    expect(makeStep()).toBe("current:Waiting in line");
    await waitFor(() => expect(makeStep()).toMatch(/^current:Making… \d+%$/), { timeout: 5000 });
    await waitFor(() => expect(makeStep()).toBe("done:"), { timeout: 8000 });
  }, 15_000);
});

describe("Classic Files: download, Get another format, Details", () => {
  function renderFiles(conversions: Conversion[]) {
    render(
      <AuthProvider>
        <BillingProvider>
          <HistoryList project={classicProject({ conversions })} />
        </BillingProvider>
      </AuthProvider>,
    );
  }

  it("downloads its files; Get another format stays off, as the gateway answers classic_retired (ADR 0137)", async () => {
    let formatReads = 0;
    server.events.on("request:start", ({ request }) => {
      if (request.method === "GET" && /\/v1\/runs\/[^/]+\/formats$/.test(new URL(request.url).pathname)) formatReads += 1;
    });
    renderFiles([classicRun()]);
    const group = await screen.findByTestId("file-group-mvhevc");
    expect(within(group).getByText("Download")).toBeTruthy();
    expect(screen.getByTestId("file-group-half_sbs")).toBeTruthy();
    await waitFor(() => expect(formatReads).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    // no control, no error, no "unavailable" line for a Classic run
    expect(screen.queryByTestId("another-format")).toBeNull();
    expect(screen.queryByTestId("another-format-unavailable")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Details: Classic rows, Bitrate (an old 20 Mbit/s as it was), no Lifelike rows", () => {
    const old20 = classicRun({
      conversion_id: "classic_20",
      bitrate_requested: "20",
      params: { preset: "4k", formats: ["mvhevc"], bitrate: 20, inpaint: "propainter", depth_res: 1442, depth_scale: 1.1 } as Conversion["params"],
      outputs_media: { mvhevc: { video_kbps: 19800, source: "ffprobe" } },
    });
    const rows = Object.fromEntries(detailRows(classicProject(), old20).map((r) => [r.label, r.value]));
    expect(rows.What).toBe("Full video · Classic 3D");
    expect(rows["3D strength"]).toBe("×1.10");
    expect(rows["Depth detail"]).toBe("1442 px");
    // the stored choice, never rewritten to Automatic
    expect(rows.Bitrate).toBe("20 Mbit/s (measured 20 Mbit/s)");
    expect(rows.Price).toBe("$49.72");
    expect(rows.Discount).toBe("−$5.52");
    for (const label of LIFELIKE_ROWS) expect(rows[label]).toBeUndefined();
  });

  it("Details: the panel opens for a Classic run with fields missing, without crashing", () => {
    const bare = {
      conversion_id: "classic_bare",
      state: "succeeded",
      kind: "video",
      project_id: PID,
      step: "production",
      params: {},
      quote: { amount_cents: 300, currency: "usd" },
      progress: 1,
      created_at: "2026-10-01T09:00:00Z",
      updated_at: "2026-10-01T09:20:00Z",
    } as unknown as Conversion;
    mockDb.conversions.set(bare.conversion_id, structuredClone(bare));
    renderFiles([bare]);
    const li = screen.getByTestId("history-classic_bare");
    fireEvent.click(within(li).getByTestId("run-details-toggle"));
    const panel = within(li).getByTestId("run-details");
    expect(panel.textContent).toContain("Classic 3D");
    expect(within(li).getByTestId("run-id").textContent).toBe("classic_bare");
    for (const label of [...LIFELIKE_ROWS, "Bitrate"]) expect(within(li).queryByTestId(`detail-${label}`)).toBeNull();
  });
});

describe("Classic runs elsewhere", () => {
  it("Previous runs lists a Classic run in plain words with its price", async () => {
    const run = classicRun();
    render(
      <AuthProvider>
        <PreviousRuns project={classicProject({ conversions: [run] })} />
      </AuthProvider>,
    );
    const row = screen.getByTestId("previous-run");
    expect(row.textContent).toContain("4K");
    expect(row.textContent).toContain("Ready");
    expect(row.textContent).toContain("$49.72");
    expect(row.textContent).not.toMatch(/File quality|Foveated|Launch offer/);
  });

  it("the 3D look page's strip renders with Classic runs on the project", async () => {
    const preview = classicRun({
      conversion_id: "classic_prev",
      step: "stereo_preview",
      params: { preset: "1080p", formats: ["sbs"], from_frame: 24, to_frame: 144 },
      quote: { amount_cents: 150, currency: "usd" },
      outputs: ["sbs"],
    });
    const full = classicRun();
    render(
      <AuthProvider>
        <StereoPanel project={classicProject({ conversions: [preview, full] })} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    // the strip renders; Lifelike's past-preview bands never take Classic runs
    expect(await screen.findByTestId("filmstrip", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryAllByTestId("strip-band")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Past previews|File quality|Foveated/);
  });

  it("Billing history: the Classic run's row and amount", async () => {
    classicRun({ charge_timing: "before" });
    render(
      <AuthProvider>
        <BillingProvider>
          <BillingScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    const row = await screen.findByTestId("row-ch_classic_run_1");
    expect(row.textContent).toContain("3D video · 4K");
    expect(within(row).getByTestId("row-amount").textContent).toBe("$49.72");
    expect(row.textContent).not.toContain("Launch offer");
  });
});

describe("Classic bitrate choices", () => {
  it("keeps Automatic, Match the source, 40/60/100; an old 20 isn't offered for new runs", () => {
    expect(BITRATES.map((b) => b.value)).toEqual(["auto", "match_source", 40, 60, 100]);
    expect(bitrateField(20)).toEqual({});
  });
});

describe("the launch offer on a Classic quote (once the gateway sends it)", () => {
  function classicQuote(breakdown: Record<string, unknown>, amount: number): StepQuoteResponse {
    return {
      step: "production",
      method: "classic",
      params: { preset: "1080p", formats: ["mvhevc"] },
      quote: {
        amount_cents: amount,
        currency: "usd",
        breakdown: { step: "production", preset: "1080p", cents_per_minute: 300, fps_factor: 1, base_cents: 900, subtotal_cents: 900, discount_cents: 0, reuse_discount_cents: 0, ...breakdown },
      },
      reuse_stages: null,
    } as StepQuoteResponse;
  }

  it("QuoteView shows the line and label from campaign_cents, not the $1 minimum", () => {
    render(<QuoteView result={classicQuote({ campaign_cents: 225, campaign_label: "Launch offer −25%" }, 675)} />);
    expect(screen.getByText("Launch offer −25%")).toBeTruthy();
    expect(screen.getByTestId("quote-campaign").textContent).toBe("−$2.25");
    expect(document.body.textContent).not.toMatch(/minimum/i);
  });

  describe("in Make 3D", () => {
    beforeEach(() => {
      mockDb.campaign = true;
      mockDb.projects.get(PID)!.method = undefined;
    });

    it("no badge or line while the gateway's offer is Lifelike only", async () => {
      render(
        <AuthProvider>
          <DeliverPanel project={classicProject()} onProjectChanged={() => {}} />
        </AuthProvider>,
      );
      fireEvent.click(within(await screen.findByTestId("quality-1080p")).getByRole("radio"));
      await screen.findByTestId("quote-breakdown", {}, { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 100));
      expect(screen.queryByTestId("quality-offer-1080p")).toBeNull();
      expect(screen.queryByTestId("quote-campaign")).toBeNull();
    });

    it("badges 1080p and 1440p and shows the quote's line when Classic is covered", async () => {
      mockDb.campaignMethods = ["lifelike", "classic"];
      render(
        <AuthProvider>
          <DeliverPanel project={classicProject()} onProjectChanged={() => {}} />
        </AuthProvider>,
      );
      expect((await screen.findByTestId("quality-offer-1080p")).textContent).toBe("−25% launch offer");
      expect(screen.getByTestId("quality-offer-qhd").textContent).toBe("−25% launch offer");
      expect(screen.queryByTestId("quality-offer-3k")).toBeNull();
      fireEvent.click(within(screen.getByTestId("quality-qhd")).getByRole("radio"));
      await waitFor(() => expect(screen.getByTestId("quote-campaign").textContent).toMatch(/^−\$\d+\.\d\d$/), { timeout: 3000 });
      expect(screen.getByText("Launch offer −25%")).toBeTruthy();
    });
  });
});
