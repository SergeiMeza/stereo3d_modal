/**
 * StepTab tests — theater layout, the shared page header, and the info
 * drawer (shadcn Drawer / vaul, opening from the right). The step panels
 * are mocked to their shared contract (project + onProjectChanged), the
 * same pattern as WorkspaceScreen.test.tsx: these tests assert the page
 * CHROME — the header shows the step's title + description with the
 * "ⓘ Tips" trigger right-aligned, the panel takes the full width (no
 * permanent right column), and the What-you-get / Tips / last-run content
 * lives in the drawer, closed by ×, Escape, or the scrim (vaul animates
 * the exit, so removal is awaited). All copy expectations derive from
 * stepDefs — never hardcoded.
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
import { afterEach, describe, expect, it, vi } from "vitest";

import { STEP_DEFS, stepDef } from "@/components/steps/stepDefs";
import type { Conversion, Project, Step } from "@/lib/api/types";

import projectFixture from "../../../fixtures/project.json";

import { StepTab } from "./StepTab";

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fixtureProject(overrides: Partial<Project> = {}): Project {
  return {
    ...(structuredClone(projectFixture) as unknown as Project),
    ...overrides,
  };
}

/** A conversion for the step so the drawer has a last-run pointer. */
function runFor(step: Step): Conversion {
  return {
    conversion_id: "run0000000001",
    state: "succeeded",
    kind: "video",
    step,
    params: { preset: "draft", formats: ["sbs"] },
    quote: { amount_cents: 50, currency: "usd" },
    progress: 1,
    created_at: "2026-07-02T08:00:00Z",
    updated_at: "2026-07-02T08:05:00Z",
  };
}

function renderTab(step: Step, project: Project = fixtureProject()) {
  const onNavigate = vi.fn();
  const onProjectChanged = vi.fn();
  render(
    <StepTab
      step={step}
      project={project}
      onProjectChanged={onProjectChanged}
      onNavigate={onNavigate}
    />,
  );
  return { onNavigate, onProjectChanged };
}

function openDrawer(): HTMLElement {
  fireEvent.click(screen.getByTestId("step-info-button"));
  return screen.getByRole("dialog");
}

/** vaul animates the exit — the drawer unmounts shortly after closing. */
async function expectDrawerClosed(): Promise<void> {
  await waitFor(
    () => expect(screen.queryByTestId("step-info-drawer")).toBeNull(),
    { timeout: 2000 },
  );
}

describe("StepTab theater layout & page header", () => {
  it("renders the panel FULL WIDTH — no permanent right column, tips copy only in the (closed) drawer", () => {
    renderTab("depth_preview");
    const def = stepDef("depth_preview");

    const tab = screen.getByTestId("step-tab-depth_preview");
    // the old two-column grid split is gone
    expect(tab.className).not.toMatch(/grid-cols/);
    expect(screen.getByTestId("step-card-depth_preview")).toBeTruthy();

    // no permanent side column: the stepDefs copy is NOT on the page…
    expect(screen.queryByText("What you get")).toBeNull();
    expect(screen.queryByText(def.tips[0])).toBeNull();
    expect(screen.queryByText(def.outputs[0])).toBeNull();
    expect(screen.queryByTestId("step-info-drawer")).toBeNull();
    // …only the unobtrusive opener is
    expect(screen.getByTestId("step-info-button").textContent).toContain("Tips");
  });

  it("shows the shared page header: step title + description with the Tips trigger right-aligned", () => {
    renderTab("stereo_preview");
    const def = stepDef("stereo_preview");

    const header = screen.getByTestId("page-header");
    expect(
      within(header).getByRole("heading", { name: def.title }),
    ).toBeTruthy();
    expect(within(header).getByText(def.description)).toBeTruthy();
    expect(within(header).getByTestId("step-info-button")).toBeTruthy();
  });

  it("passes the project through to the panel", () => {
    renderTab("stereo_preview");
    expect(screen.getByTestId("step-card-project").textContent).toBe(
      (projectFixture as { project_id: string }).project_id,
    );
  });
});

describe("StepTab info drawer", () => {
  it("ⓘ Tips opens a RIGHT-side dialog drawer with the What-you-get + Tips copy and the last-run pointer into History", () => {
    const project = fixtureProject();
    project.conversions = [runFor("depth_preview")];
    const { onNavigate } = renderTab("depth_preview", project);
    const def = stepDef("depth_preview");

    const drawer = openDrawer();
    expect(drawer.getAttribute("data-testid")).toBe("step-info-drawer");
    expect(drawer.getAttribute("aria-label")).toContain(def.title);
    // the shadcn Drawer (vaul) opens from the RIGHT
    expect(drawer.getAttribute("data-vaul-drawer-direction")).toBe("right");

    // every stepDefs bullet is present — derived, not hardcoded
    for (const line of [...def.outputs, ...def.tips]) {
      expect(within(drawer).getByText(line)).toBeTruthy();
    }
    expect(within(drawer).getByText("What you get")).toBeTruthy();
    expect(within(drawer).getByText("Tips")).toBeTruthy();

    // last-run pointer with state chip and the History jump
    expect(within(drawer).getByText("Last run")).toBeTruthy();
    expect(within(drawer).getByText("succeeded")).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "History →" }));
    expect(onNavigate).toHaveBeenCalledWith("history");
  });

  it("omits the last-run pointer when the step never ran", () => {
    renderTab("production"); // fixture has no conversions
    const drawer = openDrawer();
    expect(within(drawer).queryByText("Last run")).toBeNull();
  });

  it("closes via the × button", async () => {
    renderTab("stereo_preview");
    openDrawer();
    fireEvent.click(screen.getByLabelText("Close tips"));
    await expectDrawerClosed();
  });

  it("closes via Escape", async () => {
    renderTab("stereo_preview");
    openDrawer();
    fireEvent.keyDown(document, { key: "Escape" });
    await expectDrawerClosed();
  });

  it("closes via the scrim", async () => {
    renderTab("stereo_preview");
    openDrawer();
    const scrim = document.querySelector('[data-slot="drawer-overlay"]');
    expect(scrim).not.toBeNull();
    await userEvent.click(scrim as Element);
    await expectDrawerClosed();
  });

  it("shows the right stepDefs copy for every step", () => {
    for (const def of STEP_DEFS) {
      renderTab(def.step);
      const drawer = openDrawer();
      expect(
        within(drawer).getByRole("heading", { name: def.title }),
      ).toBeTruthy();
      expect(within(drawer).getByText(def.outputs[0])).toBeTruthy();
      expect(within(drawer).getByText(def.tips[0])).toBeTruthy();
      cleanup();
    }
  });
});
