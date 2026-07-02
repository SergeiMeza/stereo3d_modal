/**
 * Deliver page tests: the inheritance chips (last depth run's depth_res +
 * the Stereo page's shared localStorage draft), production request bodies
 * forwarding EXACTLY those values with per-field "pipeline default"
 * escapes, the reuse discount / from-scratch re-quote, and the absence of
 * any displacement control (pro steps have none).
 */

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

import type { Conversion, Project, StepConversionRequest } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { DeliverPanel } from "./DeliverPanel";
import { saveStereoDraft } from "./stereoStore";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 50 }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  mockDb.reset();
  vi.restoreAllMocks();
  window.localStorage.clear();
});
afterAll(() => server.close());

const FIXTURE = projectFixture as unknown as Project;
const VERSION = FIXTURE.scenes!.version;
const FIRST_CUT = FIXTURE.scenes!.cuts[0];

function fixtureProject(overrides: Partial<Project> = {}): Project {
  return {
    ...(structuredClone(projectFixture) as unknown as Project),
    ...overrides,
  };
}

/** A succeeded depth run whose depth_res Deliver should inherit. */
function seededDepthRun(projectId: string, depthRes = 1442): Conversion {
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
      depth_res: depthRes,
      target_fps: 12,
    },
    quote: { amount_cents: 50, currency: "usd" },
    progress: 1,
    outputs: ["anaglyph", "depth", "depth_vis"],
    created_at: "2026-07-02T08:00:00Z",
    updated_at: "2026-07-02T08:05:00Z",
  };
  mockDb.conversions.set(conv.conversion_id, structuredClone(conv));
  return conv;
}

/** The Stereo page's persisted draft: 2 overrides + depth_scale 1.1. */
function seedStereoDraft(projectId: string): void {
  saveStereoDraft(projectId, VERSION, {
    overrides: {
      "0": { displacement: 0.02 },
      [String(FIRST_CUT)]: { shot_type: "wide" },
    },
    depth_scale: 1.1,
  });
}

function renderPanel(project: Project = fixtureProject()) {
  const onProjectChanged = vi.fn();
  render(
    <AuthProvider>
      <DeliverPanel project={project} onProjectChanged={onProjectChanged} />
    </AuthProvider>,
  );
  return { onProjectChanged };
}

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

describe("DeliverPanel inheritance", () => {
  it("summary chips show the Depth page's depth_res and the Stereo page's tweaks FIRST", () => {
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    seedStereoDraft(project.project_id);
    renderPanel(project);

    expect(screen.getByTestId("deliver-chip-depth").textContent).toBe(
      "Depth 1442 ×14 (from Depth page)",
    );
    expect(screen.getByTestId("deliver-chip-stereo").textContent).toBe(
      "2 scene overrides + depth_scale 1.10 (from Stereo page)",
    );
  });

  it("production sends THE SAME depth_res, scene_overrides and depth_scale the previews set", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    seedStereoDraft(project.project_id);
    renderPanel(project);

    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    // exact body: no displacement, no target_fps (Full), inherited values in
    expect(bodies[0]).toEqual({
      step: "production",
      preset: "1080p",
      formats: ["mvhevc", "half_sbs"],
      inpaint: "propainter",
      depth_res: 1442,
      depth_scale: 1.1,
      scene_overrides: [
        { first: 0, displacement: 0.02 },
        { first: FIRST_CUT, shot_type: "wide" },
      ],
      platform: "web",
    });
  });

  it("per-field 'use pipeline default' escapes drop the inherited values", async () => {
    const bodies = captureQuoteBodies();
    const user = userEvent.setup();
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id)];
    seedStereoDraft(project.project_id);
    renderPanel(project);

    await user.click(
      screen.getByRole("checkbox", { name: "Use pipeline default depth resolution" }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Use pipeline defaults (adaptive)" }),
    );
    await getQuote(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].depth_res).toBeUndefined();
    expect(bodies[0].depth_scale).toBeUndefined();
    expect(bodies[0].scene_overrides).toBeUndefined();
  });

  it("states the fallbacks when there is nothing to inherit", () => {
    renderPanel(); // no conversions, no stereo draft
    expect(screen.getByTestId("deliver-chip-depth-none").textContent).toMatch(
      /No depth run yet/,
    );
    expect(screen.getByTestId("deliver-chip-stereo-none").textContent).toMatch(
      /No Stereo-page tweaks/,
    );
  });
});

describe("DeliverPanel controls", () => {
  it("offers presets, 4 formats (no TB), inpaint select and 'Full (no decimation)' fps default", () => {
    renderPanel();

    const preset = document.getElementById("production-preset") as HTMLSelectElement;
    expect([...preset.options].map((o) => o.value)).toEqual([
      "1080p",
      "qhd",
      "3k",
      "4k",
    ]);
    expect(preset.value).toBe("1080p");

    const formats = screen.getByRole("group", { name: "Formats" });
    const boxes = within(formats).getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    for (const name of ["SBS", "Half-SBS", "Anaglyph", "MV-HEVC"]) {
      expect(within(formats).getByRole("checkbox", { name })).toBeDefined();
    }
    expect(within(formats).queryByRole("checkbox", { name: "TB" })).toBeNull();
    expect(
      (within(formats).getByRole("checkbox", { name: "MV-HEVC" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (within(formats).getByRole("checkbox", { name: "Half-SBS" }) as HTMLInputElement)
        .checked,
    ).toBe(true);

    const inpaint = document.getElementById("production-inpaint") as HTMLSelectElement;
    expect(inpaint.value).toBe("propainter");
    expect([...inpaint.options].map((o) => o.value)).toEqual(["propainter", "none"]);

    const fps = document.getElementById("production-fps") as HTMLSelectElement;
    expect(fps.value).toBe("");
    expect(fps.selectedOptions[0].textContent).toBe("Full (no decimation)");

    // NO displacement slider anywhere on the pro steps
    expect(screen.queryByText(/displacement/i)).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("shows the reuse discount and drops it when re-quoted from scratch", async () => {
    const user = userEvent.setup();
    const project = fixtureProject();
    const prior = seededDepthRun(project.project_id);
    // strip the inherited depth_res so the quote stays at the preset default
    prior.params = { preset: "draft", formats: ["anaglyph"] };
    mockDb.conversions.set(prior.conversion_id, structuredClone(prior));
    project.conversions = [prior];
    renderPanel(project);

    await getQuote(user);
    // 1080p production: $2.50 subtotal, −40% (depth 35% + preprocess 5%)
    // reuse discount, −50¢ analyze credit → $1.00
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$2.50");
    const stages = screen.getByTestId("quote-reuse-stages");
    expect(stages.textContent).toContain("depth");
    expect(stages.textContent).toContain("preprocess");
    expect(screen.getByTestId("quote-reuse-discount").textContent).toBe("−$1.00");
    expect(screen.getByTestId("quote-total").textContent).toBe("$1.00");

    // from-scratch toggle re-quotes without the reuse discount
    await user.click(screen.getByLabelText(/Start from scratch/));
    await waitFor(() =>
      expect(screen.getByTestId("quote-total").textContent).toBe("$2.00"),
    );
    expect(screen.queryByTestId("quote-reuse-discount")).toBeNull();
    expect(screen.queryByTestId("quote-reuse-stages")).toBeNull();
  });

  it("prices the inherited depth resolution into the production quote (0.35 depth share)", async () => {
    const user = userEvent.setup();
    const project = fixtureProject();
    project.conversions = [seededDepthRun(project.project_id, 1442)];
    renderPanel(project);

    await getQuote(user);
    // base $2.50; factor (1442/980)² = 2.1651 on 35% of the base →
    // 250 × (1 + 0.35 × 1.1651) = 352¢; reuse −40% → 211¢; −50¢ → $1.61
    expect(screen.getByTestId("quote-base").textContent).toBe("$2.50");
    expect(screen.getByTestId("quote-depth-factor").textContent).toBe("×2.17");
    expect(screen.getByTestId("quote-subtotal").textContent).toBe("$3.52");
    expect(screen.getByTestId("quote-total").textContent).toBe("$1.61");
  });
});
