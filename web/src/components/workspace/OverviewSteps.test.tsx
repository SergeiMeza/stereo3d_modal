/**
 * Owner 2026-11-05: Overview's "Your steps", from the project and the
 * run's atom — done, current with its status and one action, upcoming,
 * an optional step passed by is skipped; phones get dots and the current
 * step.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { conversionAtom } from "@/components/steps/conversionAtoms";
import type { Conversion, Project } from "@/lib/api/types";
import { appStore } from "@/lib/state/stores";

import projectFixture from "../../../fixtures/project.json";

import {
  OverviewSteps,
  overviewSteps,
  primaryAction,
  secondaryAction,
  useOverviewSteps,
  type StepsContext,
} from "./OverviewSteps";

/** The stepper as Overview mounts it (the run's atom read in the hook). */
function Steps({
  project,
  onNavigate,
  ...opts
}: StepsContext & { project: Project; onNavigate: (tab: string) => void }) {
  return <OverviewSteps steps={useOverviewSteps(project, opts)} onNavigate={onNavigate} />;
}

afterEach(() => cleanup());

const base = projectFixture as unknown as Project;

function lifelike(over: Partial<Project> = {}): Project {
  return { ...structuredClone(base), method: "lifelike", conversions: [], ...over } as Project;
}

function run(step: Conversion["step"], state: Conversion["state"], over: Partial<Conversion> = {}): Conversion {
  return {
    conversion_id: `c_${step}_${state}`,
    state,
    kind: "video",
    project_id: base.project_id,
    step,
    params: { preset: "1080p", formats: ["mvhevc"] },
    quote: { amount_cents: 600, currency: "usd" },
    progress: 0.4,
    created_at: "2026-11-05T09:00:00Z",
    updated_at: "2026-11-05T09:00:00Z",
    ...over,
  } as Conversion;
}

const states = (p: Project, opts = {}) => overviewSteps(p, opts).map((s) => `${s.tab}:${s.state}${s.status ? `(${s.status})` : ""}${s.action ? `[${s.action}]` : ""}`);

describe("the steps' states", () => {
  it("analysing: Scenes is current with its percent, the rest upcoming", () => {
    const p = lifelike({ analyze: { state: "running", progress: 0.7, stage: "thumbnails" } as Project["analyze"], probe: undefined });
    expect(states(p)).toEqual([
      "scenes:current(Analyzing… 70%)",
      "preview:upcoming",
      "make:upcoming",
      "files:upcoming",
    ]);
  });

  it("analysed: the preview is next, free when the quote says so", () => {
    expect(states(lifelike(), { previewFree: true })).toEqual([
      "scenes:done",
      "preview:current(Ready)[Make a free preview]",
      "make:upcoming",
      "files:upcoming",
    ]);
    expect(overviewSteps(lifelike())[1].action).toBe("Preview a moment");
  });

  it("a full run in progress: Make 3D is current with its progress, the passed preview is skipped", () => {
    const p = lifelike({ conversions: [run("production", "processing")] });
    expect(states(p)).toEqual(["scenes:done", "preview:skipped", "make:current(Making… 40%)[See progress]", "files:upcoming"]);
  });

  it("made: Files is current with Download; a preview made earlier is done", () => {
    const p = lifelike({ conversions: [run("lifelike_preview", "succeeded"), run("production", "succeeded")] });
    expect(states(p)).toEqual(["scenes:done", "preview:done", "make:done", "files:current(Ready)[Download]"]);
  });
});

describe("Your steps", () => {
  it("numbers the steps, shows the current one's action, and goes to a step's tab", () => {
    const onNavigate = vi.fn();
    const p = lifelike({ conversions: [run("production", "processing")] });
    // the live feed's newer state wins over the listed run (owner 2026-11-07)
    appStore.set(
      conversionAtom("c_production_processing"),
      run("production", "processing", { progress: 0.6, updated_at: "2026-11-05T09:00:05Z" }),
    );
    render(<Steps project={p} previewFree onNavigate={onNavigate} />);
    const full = screen.getByTestId("steps-full");
    expect(within(full).getByTestId("step-make").getAttribute("aria-current")).toBe("step");
    expect(within(full).getByTestId("step-status").textContent).toBe("Making… 60%");
    expect(within(full).getByTestId("step-preview").textContent).toContain("Optional");
    expect(within(full).getByTestId("step-files").textContent).toContain("4");
    fireEvent.click(within(within(full).getByTestId("step-files")).getByRole("button"));
    expect(onNavigate).toHaveBeenLastCalledWith("files");
    // phones: dots and the current step
    const compact = screen.getByTestId("steps-compact");
    expect(compact.className).toContain("sm:hidden");
    expect(compact.textContent).toContain("Step 3 of 4");
    expect(compact.textContent).toContain("Make 3D · Making… 60%");
    expect(full.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "sm:grid"]));
  });

  it("no action buttons of its own (the card carries the main one); the current step keeps its status and opens its tab", () => {
    const onNavigate = vi.fn();
    const done = lifelike({ conversions: [run("production", "succeeded")] });
    render(<Steps project={done} onNavigate={onNavigate} />);
    const steps = screen.getByTestId("overview-steps");
    // QA 2026-11-05: never a second Download beside the card's
    expect(within(steps).queryByText("Download")).toBeNull();
    expect(screen.queryByTestId("step-action")).toBeNull();
    const files = within(screen.getByTestId("steps-full")).getByTestId("step-files");
    expect(within(files).getByTestId("step-status").textContent).toBe("Ready");
    fireEvent.click(within(files).getByRole("button"));
    expect(onNavigate).toHaveBeenLastCalledWith("files");
    // phones: the current step is one tap to its tab too
    fireEvent.click(within(screen.getByTestId("steps-compact")).getByRole("button"));
    expect(onNavigate).toHaveBeenLastCalledWith("files");
  });
});

describe("the card and the stepper agree (QA 2026-11-05)", () => {
  const both = (p: Project, opts: StepsContext = {}) => {
    const steps = overviewSteps(p, opts);
    const cur = steps.find((s) => s.state === "current")!;
    return { stepper: cur.action ?? null, card: primaryAction(steps)?.label ?? null, secondary: secondaryAction(steps, p)?.label ?? null, tab: primaryAction(steps)?.tab };
  };

  it("in every state the card's main action is the current step's", () => {
    const analysing = lifelike({ analyze: { state: "running", progress: 0.7 } as Project["analyze"], probe: undefined });
    expect(both(analysing)).toMatchObject({ stepper: null, card: null });
    expect(both(lifelike(), { previewFree: true })).toMatchObject({
      stepper: "Make a free preview",
      card: "Make a free preview",
      secondary: "or go straight to Make 3D",
      tab: "preview",
    });
    expect(both(lifelike(), { previewCents: 125 })).toMatchObject({ card: "Preview a moment · $1.25" });
    const previewed = lifelike({ conversions: [run("lifelike_preview", "succeeded")] });
    expect(both(previewed)).toMatchObject({ stepper: "Make 3D", card: "Make 3D", secondary: null, tab: "make" });
    const running = lifelike({ conversions: [run("production", "processing")] });
    expect(both(running)).toMatchObject({ stepper: "See progress", card: "See progress", tab: "make" });
  });

  it("a finished 3D: Download first, making it again second", () => {
    const done = lifelike({ conversions: [run("production", "succeeded")] });
    expect(both(done)).toEqual({ stepper: "Download", card: "Download", secondary: "or make it in 3D again", tab: "files" });
  });

  it("step names wrap, never cut; Optional sits under the name", () => {
    render(<Steps project={lifelike()} previewFree onNavigate={vi.fn()} />);
    const preview = screen.getByTestId("step-preview");
    const name = within(preview).getByTestId("step-name");
    expect(name.textContent).toBe("Preview");
    expect(name.className).not.toContain("truncate");
    expect(name.className).toContain("break-words");
    expect(name.nextElementSibling?.textContent).toBe("Optional");
  });
});
