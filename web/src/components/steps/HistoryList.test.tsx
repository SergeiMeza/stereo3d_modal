/**
 * Conversion history (the workspace History page): ordering, state chips,
 * quoted totals, click-to-copy support handles, downloads expander with
 * inline previews, and failed-run error messages.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
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

describe("Files (screen 09)", () => {
  it("lists runs newest-first: what it is, method, state in a word, price with a word only when unusual", () => {
    renderWithHistory([SUCCEEDED, FAILED]);
    const [first, second] = screen.getAllByRole("listitem").filter((li) =>
      li.getAttribute("data-testid")?.startsWith("history-"),
    );
    expect(first.getAttribute("data-testid")).toBe("history-conv00000newer");
    expect(within(first).getByText("Full video")).toBeDefined();
    expect(within(first).getByTestId("run-status").textContent).toBe("Failed");
    expect(within(first).getByTestId("history-price").textContent).toBe(
      "$1.50 · Not charged",
    );
    expect(within(first).getByText("Something went wrong on our side.")).toBeDefined();
    expect(within(first).getByTestId("history-method").textContent).toBe("Classic 3D");

    expect(second.getAttribute("data-testid")).toBe("history-conv00000older");
    expect(within(second).getByText("Depth preview")).toBeDefined();
    expect(within(second).getByTestId("run-status").textContent).toBe("Ready");
    expect(within(second).getByTestId("history-price").textContent).toBe("$0.50");
    // a short line: quality and date, never internal values
    expect(within(first).getByTestId("history-params").textContent).toMatch(
      /^1080p · \S+/,
    );
    expect(document.body.textContent).not.toMatch(/propainter|depth_res|conv00000/);
  });

  it("lists a finished run's files by device, depth preview scoped to its depth video", async () => {
    renderWithHistory([SUCCEEDED]);
    const files = await screen.findByTestId("run-files");
    // the depth run sells its depth video only; depth_vis is never offered
    expect(within(files).getByTestId("file-group-depth")).toBeDefined();
    expect(within(files).queryByTestId("file-group-anaglyph")).toBeNull();
    expect(within(files).getByRole("link", { name: "Download" })).toBeDefined();
  });

  it("refreshes expired links on click", async () => {
    const fetches: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname.endsWith("/downloads")) fetches.push(request.url);
    });
    renderWithHistory([
      { ...SUCCEEDED, step: "production", params: { preset: "1080p", formats: ["sbs"] } },
    ]);
    const files = await screen.findByTestId("run-files");
    expect(fetches).toHaveLength(1);
    const link = within(files).getAllByRole("link")[0] as HTMLAnchorElement;
    // a live link downloads as is
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(fetches).toHaveLength(1);
    // past expires_in: fresh links first
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 400 * 24 * 3600 * 1000);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(fetches).toHaveLength(2));
  });
});

describe("Files in a headset browser (S3D-47, screen 13b)", () => {
  it("puts this headset's files first with View in 3D on every row and one hint", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 OculusBrowser/35.1.0.0 Chrome/126.0.0.0 VR Safari/537.36",
    );
    renderWithHistory([
      {
        ...SUCCEEDED,
        step: "production",
        params: { preset: "1080p", formats: ["mvhevc", "half_sbs"] },
        outputs: ["mvhevc", "half_sbs"],
      },
    ]);
    const files = await screen.findByTestId("run-files");
    const mine = within(files).getByTestId("file-group-half_sbs");
    expect(within(mine).getByText("This headset")).toBeDefined();
    expect(within(mine).getAllByTestId("view-in-3d")[0].textContent).toBe("View in 3D");
    expect(within(files).getAllByTestId("view-in-3d-hint")).toHaveLength(1);
    // the Vision Pro file folds away
    const others = within(files).getByTestId("other-files") as HTMLDetailsElement;
    expect(others.open).toBe(false);
    expect(within(others).getByTestId("file-group-mvhevc")).toBeDefined();
  });
});
