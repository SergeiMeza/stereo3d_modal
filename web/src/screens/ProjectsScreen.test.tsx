/**
 * Projects screen tests against the stateful MSW mock gateway.
 *
 * The signed-URL PUT normally goes through client.uploadFile (XHR, for
 * progress events); XHR is flaky under jsdom+msw, so tests stub
 * GatewayClient.prototype.uploadFile — the surrounding flow
 * (POST /v1/uploads → PUT → POST /v1/projects → navigate) stays real.
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
import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import projectFixture from "../../fixtures/project.json";
import { GatewayClient } from "@/lib/api/client";
import type { Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import ProjectsScreen from "./ProjectsScreen";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

const FIXTURE_ID = "a1b2c3d4e5f6";
// derive from the fixture — it's recaptured from the real API and the scene
// detector varies ±1 across runs
const FIXTURE_SCENES = `${(projectFixture.scenes.cuts as number[]).length + 1} scenes`;
const FIXTURE_NAME = "dKmPEhJ4wjY";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup(); // vitest runs with globals:false, so RTL auto-cleanup is off
  server.resetHandlers();
  mockDb.reset();
  vi.restoreAllMocks();
  push.mockClear();
});
afterAll(() => server.close());

function renderScreen() {
  return render(
    <AuthProvider>
      <ProjectsScreen />
    </AuthProvider>,
  );
}

/** Stub the XHR leg (signed PUT); everything else hits the MSW gateway. */
function stubUploadFile() {
  return vi
    .spyOn(GatewayClient.prototype, "uploadFile")
    .mockImplementation(async (_ticket, _file, onProgress) => {
      onProgress?.(0.5);
      onProgress?.(1);
    });
}

describe("ProjectsScreen list", () => {
  it("renders the fixture project with scene count, timecode duration, and resolution", async () => {
    renderScreen();
    const card = await screen.findByRole("link", {
      name: new RegExp(FIXTURE_NAME),
    });
    expect(card.getAttribute("href")).toBe(`/projects/${FIXTURE_ID}`);
    expect(within(card).getByText(FIXTURE_SCENES)).toBeTruthy();
    // 3587 frames @ 24/1 → 00:02:29:11 (frames.ts, not float math)
    expect(within(card).getByText("00:02:29:11")).toBeTruthy();
    expect(within(card).getByText("3840×2160")).toBeTruthy();
    expect(within(card).getByText("Analyzed")).toBeTruthy();
  });

  it("shows a red failed badge with the analyze error", async () => {
    const p = mockDb.projects.get(FIXTURE_ID);
    if (!p) throw new Error("fixture project missing");
    p.analyze = {
      state: "failed",
      error: "probe failed: unsupported codec",
      credit_cents: 0,
      credit_available: false,
    };
    renderScreen();
    expect(
      await screen.findByText(/Analyze failed — probe failed: unsupported codec/),
    ).toBeTruthy();
  });

  it("shows the running badge's stage label, percent, and eta when the gateway sends progress", async () => {
    const p = mockDb.projects.get(FIXTURE_ID);
    if (!p) throw new Error("fixture project missing");
    p.analyze = {
      state: "running",
      error: "",
      credit_cents: 0,
      credit_available: false,
      progress: 0.45,
      stage: "proxy",
      eta_seconds: 22,
    };
    renderScreen();
    const badge = await screen.findByTestId("analyze-badge-running");
    expect(badge.textContent).toContain("Building preview");
    expect(badge.textContent).toContain("45%");
    expect(badge.textContent).toContain("~22s left");
    expect(within(badge).getByLabelText("Analyze progress")).toBeTruthy();
  });

  it("shows an empty state inviting upload when there are no projects", async () => {
    mockDb.projects.clear();
    renderScreen();
    expect(await screen.findByText("No projects yet")).toBeTruthy();
    expect(
      screen.getByText(/Drop a video above to start your first 3D conversion/),
    ).toBeTruthy();
  });

  it("polls the list every 5s while a project is analyzing, and stops after", async () => {
    const p = mockDb.projects.get(FIXTURE_ID);
    if (!p) throw new Error("fixture project missing");
    p.analyze = {
      state: "running",
      error: "",
      credit_cents: 0,
      credit_available: false,
    };
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      renderScreen();
      expect(await screen.findByText("Analyzing")).toBeTruthy();
      // server-side: analyze finishes
      p.analyze = {
        state: "succeeded",
        error: "",
        credit_cents: 50,
        credit_available: true,
      };
      await vi.advanceTimersByTimeAsync(5000);
      expect(await screen.findByText("Analyzed")).toBeTruthy();
      expect(vi.getTimerCount()).toBe(0); // interval cleared once nothing runs
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ProjectsScreen upload", () => {
  it("uploads a video, creates the project (name = filename stem), and navigates", async () => {
    const uploadSpy = stubUploadFile();
    renderScreen();
    await screen.findByRole("link", { name: new RegExp(FIXTURE_NAME) });

    const input = screen.getByLabelText("Upload video");
    const file = new File(["mock-bytes"], "beach_day.mp4", {
      type: "video/mp4",
    });
    await userEvent.upload(input, file);

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const dest = push.mock.calls[0][0] as string;
    expect(dest.startsWith("/projects/")).toBe(true);

    // POST /v1/projects was reached: the mock db has the new project,
    // named after the filename stem.
    const created = mockDb.projects.get(dest.slice("/projects/".length));
    expect(created?.name).toBe("beach_day");
    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });

  it("ensures the billing profile (POST /v1/customers) before creating the project", async () => {
    stubUploadFile();
    const order: string[] = [];
    server.events.on("request:start", ({ request }) => {
      const path = new URL(request.url).pathname;
      if (
        request.method === "POST" &&
        (path === "/v1/customers" || path === "/v1/projects")
      ) {
        order.push(path);
      }
    });
    renderScreen();
    await screen.findByRole("link", { name: new RegExp(FIXTURE_NAME) });

    const input = screen.getByLabelText("Upload video");
    await userEvent.upload(
      input,
      new File(["mock-bytes"], "beach_day.mp4", { type: "video/mp4" }),
    );

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["/v1/customers", "/v1/projects"]);
  });

  it("rejects files that are not .mp4/.mov/.m4v", async () => {
    renderScreen();
    await screen.findByRole("link", { name: new RegExp(FIXTURE_NAME) });

    const dropzone = screen.getByTestId("upload-dropzone");
    const file = new File(["not a video"], "notes.txt", {
      type: "text/plain",
    });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });

    expect(await screen.findByText(/Unsupported file type/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    // only the fixture project exists — nothing was created
    expect(mockDb.projects.size).toBe(1);
  });

  it("shows the gateway error message when project creation fails (400)", async () => {
    stubUploadFile();
    server.use(
      http.post(`${GATEWAY}/v1/projects`, () =>
        HttpResponse.json(
          {
            success: false,
            error: "invalid_request",
            message: "gcs_key is not one of your uploads",
          },
          { status: 400 },
        ),
      ),
    );
    renderScreen();
    await screen.findByRole("link", { name: new RegExp(FIXTURE_NAME) });

    const input = screen.getByLabelText("Upload video");
    const file = new File(["mock-bytes"], "beach_day.mp4", {
      type: "video/mp4",
    });
    await userEvent.upload(input, file);

    expect(
      await screen.findByText("gcs_key is not one of your uploads"),
    ).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("ProjectsScreen management", () => {
  /** Seed an extra project into the mock db (fixture clone + overrides). */
  function addProject(overrides: Partial<Project>): Project {
    const template = structuredClone(projectFixture) as unknown as Project;
    const p = { ...template, archived: false, ...overrides };
    mockDb.projects.set(p.project_id, p);
    return p;
  }

  it("renders pinned projects first under a Pinned section", async () => {
    // OLDER than the fixture project — pinning must still order it first
    addProject({
      project_id: "pinnedvideo1",
      name: "Pinned video",
      pinned: true,
      created_at: "2026-07-01T00:00:00Z",
    });
    renderScreen();
    expect(await screen.findByRole("heading", { name: "Pinned" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "All projects" })).toBeTruthy();
    const links = screen.getAllByRole("link");
    expect(links[0].textContent).toContain("Pinned video");
    expect(links[1].textContent).toContain(FIXTURE_NAME);
  });

  it("pins a project via the pin button and re-renders it as pinned", async () => {
    renderScreen();
    await screen.findByRole("link", { name: new RegExp(FIXTURE_NAME) });
    fireEvent.click(screen.getByRole("button", { name: "Pin project" }));
    // PATCH reached the mock gateway…
    await waitFor(() =>
      expect(mockDb.projects.get(FIXTURE_ID)?.pinned).toBe(true),
    );
    // …and the reloaded list reflects it
    expect(
      await screen.findByRole("button", { name: "Unpin project" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pinned" })).toBeTruthy();
  });

  it("renames a project via the dialog, trimming the name", async () => {
    renderScreen();
    await screen.findByRole("link", { name: new RegExp(FIXTURE_NAME) });
    fireEvent.click(screen.getByRole("button", { name: "Rename project" }));
    const input = await screen.findByLabelText("Project name");
    expect((input as HTMLInputElement).value).toBe(FIXTURE_NAME);
    fireEvent.change(input, { target: { value: "  Beach day  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockDb.projects.get(FIXTURE_ID)?.name).toBe("Beach day"),
    );
    expect(
      await screen.findByRole("link", { name: /Beach day/ }),
    ).toBeTruthy();
  });

  it("archives a project after confirmation, removing it from the active list", async () => {
    renderScreen();
    await screen.findByRole("link", { name: new RegExp(FIXTURE_NAME) });
    fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
    expect(
      await screen.findByText(/A project with a running conversion/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(mockDb.projects.get(FIXTURE_ID)?.archived).toBe(true),
    );
    expect(await screen.findByText("No projects yet")).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: new RegExp(FIXTURE_NAME) }),
    ).toBeNull();
  });

  it("lists archived projects behind the toggle and restores back to active", async () => {
    const p = mockDb.projects.get(FIXTURE_ID);
    if (!p) throw new Error("fixture project missing");
    p.archived = true;
    renderScreen();
    expect(await screen.findByText("No projects yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    const card = await screen.findByRole("link", {
      name: new RegExp(FIXTURE_NAME),
    });
    expect(card).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Hide archived (1)" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restore project" }));
    await waitFor(() =>
      expect(mockDb.projects.get(FIXTURE_ID)?.archived).toBe(false),
    );
    // back in the active grid, with the archived section now empty
    expect(await screen.findByText("No archived projects.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: new RegExp(FIXTURE_NAME) }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Archive project" }),
    ).toBeTruthy();
    expect(screen.queryByText("No projects yet")).toBeNull();
  });
});
