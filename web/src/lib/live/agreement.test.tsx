/**
 * Owner bug 2026-11-07: Overview's "Your steps" sat on "Make 3D: Making…
 * 62%" after the run had finished, while other tabs showed it done. Every
 * surface now reads the one live feed (lib/live), so one run driven
 * through the stream's events — queued, making %, finished or failed —
 * reads the same moment on each of them: Overview's steps, the Make 3D
 * tracker, Previous runs, the Files row and the project card.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JSX } from "react";

import projectFixture from "../../../fixtures/project.json";
import { HandoffSheet } from "@/components/pay/HandoffSheet";
import { PAID_STARTING } from "@/components/pay/payCopy";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { RunFiles } from "@/components/steps/RunFiles";
import { ConversionTracker } from "@/components/steps/ConversionTracker";
import { HistoryList } from "@/components/steps/HistoryList";
import { PreviousRuns } from "@/components/steps/PreviousRuns";
import { OverviewSteps, useOverviewSteps } from "@/components/workspace/OverviewSteps";
import type { Conversion, Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import { appStore } from "@/lib/state/stores";

import { parseLiveEvent } from "./events";
import { applyLiveEvent } from "./liveStore";
import { useLiveProject } from "./useLive";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const base = projectFixture as unknown as Project;
const PID = base.project_id;
const T0 = Date.parse("2026-11-07T08:00:00Z");

function at(s: number): string {
  return new Date(T0 + s * 1000).toISOString();
}

function theRun(over: Partial<Conversion> = {}): Conversion {
  return {
    conversion_id: "agree0000001",
    project_id: PID,
    state: "paid",
    kind: "video",
    step: "production",
    method: "lifelike",
    params: { preset: "1080p", formats: ["mvhevc"] },
    quote: { amount_cents: 1200, currency: "usd" },
    progress: 0,
    billing: { status: "charged", charged_cents: 1200 },
    created_at: at(0),
    updated_at: at(0),
    ...over,
  } as Conversion;
}

let seq = 0;

/** One event as the gateway sends it, through the client's own parser. */
function send(event: string, data: Record<string, unknown>): void {
  seq += 1;
  const ev = parseLiveEvent(event, JSON.stringify({ type: event, ...data }), String(seq));
  if (ev === null) throw new Error(`unreadable ${event}`);
  act(() => {
    applyLiveEvent(appStore, ev);
  });
}

function runState(run: Conversion, s: number): void {
  send("run.state", {
    run_id: run.conversion_id,
    project_id: PID,
    version: (T0 + s * 1000) * 1000,
    state: run.state,
    run: { ...run, updated_at: at(s) },
  });
}

function runProgress(run: Conversion, s: number, progress: number, stage: string): void {
  send("run.progress", {
    run_id: run.conversion_id,
    project_id: PID,
    version: (T0 + s * 1000) * 1000,
    state: "processing",
    progress,
    stage,
    eta_seconds: 40,
    waiting_for_gpu: false,
    queued_s: 0,
  });
}

/** Overview's steps, as the Overview tab mounts them. */
function Overview({ project }: { project: Project }): JSX.Element {
  return <OverviewSteps steps={useOverviewSteps(project)} onNavigate={() => {}} />;
}

/** The project page (each tab's surface at once, as if switched between)
 * and the projects list's card, side by side. */
function Page({ project, run }: { project: Project; run: Conversion }): JSX.Element {
  const live = useLiveProject(project);
  return (
    <>
      <div data-testid="overview">
        <Overview project={project} />
      </div>
      <div data-testid="make">
        <ConversionTracker conversion={run} onProjectChanged={() => {}} showDownloads={false} />
        <PreviousRuns project={live} />
      </div>
      <div data-testid="files">
        <HistoryList project={live} />
      </div>
      <div data-testid="list">
        <ProjectCard project={{ ...project, conversions: undefined, summary: { latest_state: "paid", spent_cents: 0 } }} />
      </div>
    </>
  );
}

function surfaces() {
  const overview = within(screen.getByTestId("overview"));
  const make = within(screen.getByTestId("make"));
  const files = within(screen.getByTestId("files"));
  const list = within(screen.getByTestId("list"));
  const step = (tab: string) => overview.getByTestId(`step-${tab}`);
  const tracker = make.getByTestId("conversion-tracker");
  return {
    makeStep: `${step("make").getAttribute("data-state")}:${within(step("make")).queryByTestId("step-status")?.textContent ?? ""}`,
    filesStep: step("files").getAttribute("data-state"),
    tracker: within(tracker).getAllByTestId("run-status")[0].textContent,
    previous: make.getByTestId("previous-run").textContent ?? "",
    filesRow: files.getByTestId("run-status").textContent,
    filesBar: files.queryByTestId("run-compact-step")?.textContent ?? null,
    card: list.getByTestId("card-state").textContent ?? "",
  };
}

function renderPage(run: Conversion): void {
  const project = { ...structuredClone(base), method: "lifelike", conversions: [run] } as Project;
  mockDb.conversions.set(run.conversion_id, structuredClone(run));
  render(
    <AuthProvider>
      <Page project={project} run={run} />
    </AuthProvider>,
  );
}

describe("every surface agrees, at every step of one run (owner bug 2026-11-07)", () => {
  beforeEach(() => {
    // no mock stream: the test sends each event itself
    mockDb.eventsDown = true;
    seq = 0;
  });

  it("queued → making 62% → finished", () => {
    const run = theRun();
    renderPage(run);

    // queued: waiting for a GPU
    runState({ ...run, state: "processing", waiting_for_gpu: true, stage: "queued" }, 1);
    let s = surfaces();
    expect(s.makeStep).toBe("current:Waiting in line");
    expect(s.filesStep).toBe("upcoming");
    expect(s.tracker).toBe("Waiting in line");
    expect(s.previous).toContain("Waiting in line");
    expect(s.filesRow).toBe("Waiting in line");
    expect(s.card).toContain("Waiting in line");

    // making, 62%
    runProgress(run, 2, 0.62, "render");
    s = surfaces();
    expect(s.makeStep).toBe("current:Making… 62%");
    expect(s.tracker).toBe("Making your 3D");
    expect(s.previous).toContain("Making…");
    expect(s.filesRow).toBe("Making your 3D");
    expect(s.filesBar).toContain("Rendering");
    expect(s.card).toContain("Making 3D · 62%");

    // a progress event sent before the next one but delivered after it
    runProgress(run, 1.5, 0.3, "plan");
    expect(surfaces().makeStep).toBe("current:Making… 62%");

    // finished: Make 3D is done and Files is the current step, everywhere
    runState({ ...run, state: "succeeded", progress: 1, stage: "done", outputs: ["mvhevc.mov"] }, 3);
    s = surfaces();
    expect(s.makeStep).toBe("done:");
    expect(s.filesStep).toBe("current");
    expect(s.tracker).toBe("Ready");
    expect(s.previous).toContain("Ready");
    expect(s.filesRow).toBe("Ready");
    expect(s.filesBar).toBeNull();
    expect(s.card).toContain("3D ready");

    // a duplicate of an older event (a resume's overlap) changes nothing
    runProgress(run, 2, 0.62, "render");
    expect(surfaces().makeStep).toBe("done:");
  });

  it("queued → making → failed", () => {
    const run = theRun();
    renderPage(run);
    runState({ ...run, state: "paid" }, 1);
    let s = surfaces();
    expect(s.makeStep).toBe("current:Waiting in line");
    expect(s.tracker).toBe("Waiting in line");
    expect(s.filesRow).toBe("Waiting in line");
    expect(s.card).toContain("Waiting in line");

    runProgress(run, 2, 0.4, "render");
    s = surfaces();
    expect(s.makeStep).toBe("current:Making… 40%");
    expect(s.card).toContain("Making 3D · 40%");

    runState({ ...run, state: "failed", progress: 0.4, billing: { status: "not_charged" } }, 3);
    s = surfaces();
    // nothing runs and nothing was made: the flow is back at its next
    // step (the optional preview), Make 3D after it
    expect(s.makeStep).toBe("upcoming:");
    expect(s.filesStep).toBe("upcoming");
    expect(s.tracker).toBe("Failed, not charged");
    expect(s.previous).toContain("Failed");
    expect(s.filesRow).toBe("Failed");
    expect(s.filesBar).toBeNull();
    expect(s.card).toContain("Failed, not charged");
  });
});

describe("format jobs and hand-off links follow the same feed (owner 2026-11-07)", () => {
  beforeEach(() => {
    mockDb.eventsDown = true;
    seq = 0;
  });

  it("run.formats: a new format's row goes from making to its file, with no timer", async () => {
    const run = theRun({ state: "succeeded", progress: 1, outputs: ["mvhevc"] });
    mockDb.conversions.set(run.conversion_id, structuredClone(run));
    mockDb.formatJobs.set(run.conversion_id, {
      sbs: { job_id: "jfmt1", status: "processing", polls: 0, requested_at: at(1), finished_at: null },
    });
    render(
      <AuthProvider>
        <BillingProvider>
          <RunFiles conversion={run} />
        </BillingProvider>
      </AuthProvider>,
    );
    expect(await screen.findByTestId("another-format-making-sbs")).toBeTruthy();
    // the gateway finishes it: the job and the run's file names change together
    mockDb.formatJobs.get(run.conversion_id)!.sbs!.status = "succeeded";
    mockDb.conversions.get(run.conversion_id)!.outputs = ["mvhevc", "sbs"];
    send("run.formats", {
      run_id: run.conversion_id,
      project_id: PID,
      version: (T0 + 9000) * 1000,
      formats: {
        available: [],
        have: ["mvhevc", "sbs"],
        pending: [],
        price_cents: 0,
        jobs: { sbs: { job_id: "jfmt1", status: "succeeded", source: "repack", price_cents: 0, requested_at: at(1), finished_at: at(9) } },
      },
      outputs: ["mvhevc", "sbs"],
    });
    expect(await screen.findByTestId("file-group-sbs")).toBeTruthy();
    expect(screen.queryByTestId("another-format-making-sbs")).toBeNull();
  });

  it("handoff.state: paying on the other device, then the run itself says it's paid", async () => {
    const run = theRun({ state: "created", billing: { status: "requires_payment" } as Conversion["billing"] });
    mockDb.conversions.set(run.conversion_id, structuredClone(run));
    render(
      <AuthProvider>
        <HandoffSheet conversionId={run.conversion_id} onPayHere={() => {}} onClose={() => {}} />
      </AuthProvider>,
    );
    await screen.findByTestId("handoff-link");
    const code = [...mockDb.billing.handoffs.keys()][0];
    send("handoff.state", { code, run_id: run.conversion_id, version: (T0 + 2000) * 1000, state: "paying" });
    expect(screen.getByTestId("handoff-state").textContent).toContain("Paying on your other device");
    runState({ ...run, state: "paid", billing: { status: "charged", charged_cents: 1200 } }, 3);
    expect(await screen.findByText(PAID_STARTING)).toBeTruthy();
  });
});
