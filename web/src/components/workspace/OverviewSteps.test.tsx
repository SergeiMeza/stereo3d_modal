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

import { OverviewSteps, overviewSteps } from "./OverviewSteps";

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
    expect(overviewSteps(lifelike())[1].action).toBe("Make a preview");
  });

  it("a full run in progress: Make 3D is current with its progress, the passed preview is skipped", () => {
    const p = lifelike({ conversions: [run("production", "processing")] });
    expect(states(p)).toEqual(["scenes:done", "preview:skipped", "make:current(Making… 40%)", "files:upcoming"]);
    // the tracker's latest poll wins over the listed run
    const live = run("production", "processing", { progress: 0.85 });
    expect(overviewSteps(p, { live })[2].status).toBe("Making… 85%");
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
    appStore.set(conversionAtom("c_production_processing"), run("production", "processing", { progress: 0.6 }));
    render(<OverviewSteps project={p} previewFree onNavigate={onNavigate} />);
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

  it("the current step's one action goes to its tab", () => {
    const onNavigate = vi.fn();
    render(<OverviewSteps project={lifelike()} previewFree onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTestId("step-action"));
    expect(onNavigate).toHaveBeenLastCalledWith("preview");
    expect(screen.getByTestId("step-action").textContent).toBe("Make a free preview");
  });
});
