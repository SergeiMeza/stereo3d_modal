/**
 * Conversion history (the workspace History page): ordering, state chips,
 * quoted totals, click-to-copy support handles, downloads expander with
 * inline previews, and failed-run error messages.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
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

import type { Conversion, Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { HistoryList } from "./HistoryList";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const PROJECT_ID = (projectFixture as { project_id: string }).project_id;

const SUCCEEDED: Conversion = {
  conversion_id: "conv00000older",
  state: "succeeded",
  kind: "video",
  project_id: PROJECT_ID,
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
  outputs: ["anaglyph", "half_sbs", "depth", "depth_vis"],
  created_at: "2026-07-02T09:00:00Z",
  updated_at: "2026-07-02T09:10:00Z",
};

const FAILED: Conversion = {
  conversion_id: "conv00000newer",
  state: "failed",
  kind: "video",
  project_id: PROJECT_ID,
  step: "production",
  params: {
    preset: "1080p",
    formats: ["mvhevc", "half_sbs"],
    inpaint: "propainter",
    depth_res: 1442,
    depth_scale: 1.1,
    scene_overrides: [
      { first: 0, displacement: 0.02 },
      { first: 266, shot_type: "wide" },
      { first: 314, shot_type: "close_up" },
    ],
  },
  quote: { amount_cents: 150, currency: "usd" },
  progress: 0.4,
  error: {
    code: "upstream_error",
    message:
      "Conversion failed — contact support with conversion_id conv00000newer.",
  },
  created_at: "2026-07-02T10:00:00Z",
  updated_at: "2026-07-02T10:05:00Z",
};

function renderWithHistory(conversions: Conversion[]) {
  // history reads props.project.conversions; the mock db must agree so the
  // downloads endpoint recognizes the succeeded run
  for (const c of conversions) {
    mockDb.conversions.set(c.conversion_id, structuredClone(c));
  }
  const project: Project = {
    ...(structuredClone(projectFixture) as unknown as Project),
    conversions: conversions.map((c) => structuredClone(c)),
  };
  render(
    <AuthProvider>
      <HistoryList project={project} />
    </AuthProvider>,
  );
}

describe("HistoryList", () => {
  it("lists conversions newest-first with step, state, total, id, and time", () => {
    renderWithHistory([SUCCEEDED, FAILED]);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);

    // newest (the failed production run) first
    const [first, second] = rows;
    expect(first.getAttribute("data-testid")).toBe("history-conv00000newer");
    expect(within(first).getByText("Production")).toBeDefined();
    expect(within(first).getByText("failed")).toBeDefined();
    expect(within(first).getByText("$1.50")).toBeDefined();
    expect(within(first).getByText(FAILED.error!.message)).toBeDefined();

    expect(second.getAttribute("data-testid")).toBe("history-conv00000older");
    expect(within(second).getByText("Depth preview")).toBeDefined();
    expect(within(second).getByText("succeeded")).toBeDefined();
    expect(within(second).getByText("$0.50")).toBeDefined();

    // created time is rendered as a <time> bound to the ISO timestamp
    expect(
      first.querySelector(`time[datetime="${FAILED.created_at}"]`),
    ).not.toBeNull();
  });

  it("summarizes each run's pro params: depth_res, inpaint, depth_scale, override count, formats", () => {
    renderWithHistory([SUCCEEDED, FAILED]);

    const [first, second] = screen.getAllByRole("listitem");
    // the production run carries the full per-scene parameter set
    expect(within(first).getByTestId("history-params").textContent).toBe(
      "1080p · mvhevc+half_sbs · depth 1442 · propainter · depth_scale 1.1 · 3 scene overrides",
    );
    // the depth run: no scene params, but resolution/fps/inpaint
    expect(within(second).getByTestId("history-params").textContent).toBe(
      "draft · anaglyph · depth 980 · none · 12 fps",
    );
  });

  it("copies the conversion_id support handle on click", async () => {
    const user = userEvent.setup();
    renderWithHistory([SUCCEEDED]);

    await user.click(
      screen.getByRole("button", { name: SUCCEEDED.conversion_id }),
    );
    expect(await screen.findByText("copied")).toBeDefined();
    expect(await navigator.clipboard.readText()).toBe(
      SUCCEEDED.conversion_id,
    );
  });

  it("expands downloads for succeeded runs with inline stereo previews", async () => {
    const user = userEvent.setup();
    renderWithHistory([SUCCEEDED, FAILED]);

    // only the succeeded run offers downloads
    const buttons = screen.getAllByRole("button", { name: "Downloads" });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]);

    const anaglyph = await screen.findByRole("link", { name: "anaglyph" });
    // signed/public URL from the /downloads endpoint, straight into href
    expect(anaglyph.getAttribute("href")).toMatch(
      /^https:\/\/storage\.googleapis\.com\/.+\/anaglyph\.mp4$/,
    );
    expect(screen.getByRole("link", { name: "half_sbs" })).toBeDefined();
    expect(screen.getByRole("link", { name: "depth" })).toBeDefined();
    expect(screen.getByRole("link", { name: "depth_vis" })).toBeDefined();

    // anaglyph + half_sbs + the 8-bit depth_vis get inline players; the raw
    // 16-bit depth stays a plain link
    expect(screen.getByTestId("preview-anaglyph").tagName).toBe("VIDEO");
    expect(screen.getByTestId("preview-half_sbs").tagName).toBe("VIDEO");
    expect(screen.getByTestId("preview-depth_vis").tagName).toBe("VIDEO");
    expect(screen.queryByTestId("preview-depth")).toBeNull();
  });
});
