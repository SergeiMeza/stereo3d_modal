/**
 * Projects screen tests against the stateful MSW mock gateway.
 *
 * The signed-URL PUT normally goes through client.uploadFile (XHR, for
 * progress events); XHR is flaky under jsdom+msw, so tests stub
 * GatewayClient.prototype.uploadFile — the surrounding flow
 * (POST /v1/uploads → PUT → POST /v1/projects → navigate) stays real.
 */

import {
  act,
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
import { maxDurationFor } from "@/components/projects/UploadDropzone";
import { GatewayClient, GatewayError } from "@/lib/api/client";
import { browserNav, NAV_FALLBACK_MS } from "@/lib/navigation";
import { posterUrl, type Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import { projectCreatedAtom } from "@/components/projects/projectsAtoms";
import { appStore } from "@/lib/state/stores";

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
  it("renders a card with the length, method, outcome and spend (S3D-35)", async () => {
    renderScreen();
    const card = await screen.findByRole("link", {
      name: new RegExp(FIXTURE_NAME),
    });
    expect(card.getAttribute("href")).toBe(`/projects/${FIXTURE_ID}`);
    expect(within(card).getByText("2:29")).toBeTruthy();
    expect(within(card).getByTestId("card-method").textContent).toBe(
      "Classic 3D · Older method",
    );
    const box = screen.getByTestId("project-card");
    expect(within(box).getByTestId("card-state").textContent).toBe("Ready for 3D");
    // S3D-35: no money on cards
    expect(within(box).queryByTestId("card-spent")).toBeNull();
    expect(box.textContent).not.toMatch(/\$|spent/i);
    void FIXTURE_SCENES;
  });

  it("the card shows the gateway's poster over the first scene's frame (gateway 00140)", async () => {
    const p = mockDb.projects.get(FIXTURE_ID)!;
    p.poster = { frame: 48, url: "https://example.test/poster.jpg" };
    renderScreen();
    const card = await screen.findByTestId("project-card");
    await waitFor(() => expect(card.querySelector("img")?.getAttribute("src")).toBe("https://example.test/poster.jpg"));
    expect(posterUrl({ poster: null, scene_thumbs: [{ frame: 1, url: "scene.jpg" }] })).toBe("scene.jpg");
    expect(posterUrl({ scene_thumbs: [], strip_thumbs: [{ frame: 0, url: "tile.jpg" }] })).toBe("tile.jpg");
    expect(
      posterUrl({ poster: { frame: 48, url: "poster.jpg" }, scene_thumbs: [{ frame: 1, url: "scene.jpg" }] }),
    ).toBe("poster.jpg");
  });

  it("past the free limits: the limits notice with Add payment method (P11)", async () => {
    mockDb.billing.limits = { projects_left: 0, bytes_left: 0, reached: true };
    render(
      <AuthProvider>
        <BillingProvider>
          <ProjectsScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    const notice = await screen.findByTestId("limits-notice");
    expect(notice.textContent).toBe(
      "Make your first 3D video or save a payment method to keep more than 3 projects and 10 GB of uploads. Add payment method",
    );
  });

  it("warns before unused files go and Keep cancels it (S3D-24)", async () => {
    const at = new Date(Date.now() + 5 * 24 * 3600 * 1000);
    const p = mockDb.projects.get(FIXTURE_ID) as Project;
    p.files_delete_at = at.toISOString();
    renderScreen();
    const line = await screen.findByTestId("card-files-delete");
    expect(line.textContent).toContain("Files deleted on");
    expect(line.textContent).toContain("Keep");
    fireEvent.click(within(line).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(screen.queryByTestId("card-files-delete")).toBeNull());
    expect(p.files_delete_at).toBeUndefined();
  });

  it("a project whose files are gone says so and offers nothing to open (S3D-24)", async () => {
    const p = mockDb.projects.get(FIXTURE_ID) as Project;
    p.files_deleted_at = "2026-10-30T00:00:00Z";
    renderScreen();
    const state = await screen.findByTestId("card-state");
    expect(state.textContent).toBe("Files deleted on Oct 30, 2026");
    expect(screen.queryByTestId("card-files-delete")).toBeNull();
    expect(screen.queryByRole("link", { name: "Files" })).toBeNull();
  });

  it("says nothing while deletion is more than 14 days away (S3D-24)", async () => {
    const p = mockDb.projects.get(FIXTURE_ID) as Project;
    p.files_delete_at = new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString();
    renderScreen();
    await screen.findByTestId("project-card");
    expect(screen.queryByTestId("card-files-delete")).toBeNull();
  });

  it("shows a finished project's outcome, never what it cost (S3D-35)", async () => {
    mockDb.conversions.set("c0000000done", {
      conversion_id: "c0000000done",
      state: "succeeded",
      kind: "video",
      project_id: FIXTURE_ID,
      step: "production",
      params: { preset: "1080p", formats: ["sbs"] },
      quote: { amount_cents: 2025, currency: "usd" },
      progress: 1,
      outputs: ["sbs"],
      billing: { status: "charged", charged_cents: 2025 },
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    renderScreen();
    const state = await screen.findByTestId("card-state");
    expect(state.textContent).toBe("3D ready");
    expect(screen.getByRole("link", { name: "Files" }).getAttribute("href")).toBe(
      `/projects/${FIXTURE_ID}#tab=files`,
    );
    expect(screen.queryByTestId("card-spent")).toBeNull();
    expect(screen.getByTestId("project-card").textContent).not.toContain("$20.25");
  });

  it("a failed payment reads Payment needed with Update payment method", async () => {
    mockDb.conversions.set("c0000000fail", {
      conversion_id: "c0000000fail",
      state: "succeeded",
      kind: "video",
      project_id: FIXTURE_ID,
      step: "production",
      params: { preset: "1080p", formats: ["sbs"] },
      quote: { amount_cents: 988, currency: "usd" },
      progress: 1,
      outputs: ["sbs"],
      billing: { status: "charge_failed" },
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    renderScreen();
    expect((await screen.findByTestId("card-state")).textContent).toBe(
      "Payment needed",
    );
    expect(screen.getByRole("link", { name: "Update payment method" })).toBeTruthy();
  });

  it("an unreadable video says so", async () => {
    const p = mockDb.projects.get(FIXTURE_ID);
    if (!p) throw new Error("fixture project missing");
    p.analyze = {
      state: "failed",
      error: "probe failed: unsupported codec",
      credit_cents: 0,
      credit_available: false,
    };
    renderScreen();
    expect((await screen.findByTestId("card-state")).textContent).toBe(
      "Couldn't read this video",
    );
  });

  it("shows getting-ready progress and time left while the free analysis runs", async () => {
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
    const state = await screen.findByTestId("card-state");
    expect(state.textContent).toBe("Getting your video ready · 45%");
    expect(screen.getByText("about 20 s left")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("a failed list shows the error with Retry, never the empty state (owner bug 2026-11-05)", async () => {
    let fail = true;
    server.use(
      http.get(`${GATEWAY}/v1/projects`, ({ request }) =>
        fail && !new URL(request.url).searchParams.get("archived")
          ? HttpResponse.json({ error: "server_error", message: "upstream timeout" }, { status: 502 })
          : undefined,
      ),
    );
    renderScreen();
    const err = await screen.findByTestId("projects-error");
    expect(err.textContent).toContain("Couldn't load your projects.");
    expect(screen.queryByText("Drop a video to start your first project")).toBeNull();
    fail = false;
    fireEvent.click(within(err).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: new RegExp(FIXTURE_NAME) })).toBeTruthy();
    expect(screen.queryByTestId("projects-error")).toBeNull();
  });

  it("an empty list, then a project made elsewhere: back on Projects it shows, no reload (owner bug 2026-11-05)", async () => {
    mockDb.projects.clear();
    renderScreen();
    expect(await screen.findByText("Drop a video to start your first project")).toBeTruthy();
    // made from another page (or tab): the created project joins at once
    const made = { ...(projectFixture as unknown as Project), project_id: "made00000001", name: "IMG_2026" };
    act(() => appStore.set(projectCreatedAtom, made));
    expect(await screen.findByRole("link", { name: /IMG_2026/ })).toBeTruthy();
    expect(screen.queryByText("Drop a video to start your first project")).toBeNull();
  });

  it("a page left open reads the list again when it comes back into view", async () => {
    mockDb.projects.clear();
    renderScreen();
    expect(await screen.findByText("Drop a video to start your first project")).toBeTruthy();
    // uploaded and created on another device or tab meanwhile
    mockDb.projects.set(FIXTURE_ID, projectFixture as unknown as Project);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByRole("link", { name: new RegExp(FIXTURE_NAME) })).toBeTruthy();
    expect(screen.queryByText("Drop a video to start your first project")).toBeNull();
  });

  it("an answer without a list is an error too, never an empty list", async () => {
    server.use(http.get(`${GATEWAY}/v1/projects`, () => HttpResponse.json({ ok: true })));
    renderScreen();
    expect(await screen.findByTestId("projects-error")).toBeTruthy();
    expect(screen.queryByText("Drop a video to start your first project")).toBeNull();
  });

  it("a list that never answers ends in the error after 15 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      server.use(http.get(`${GATEWAY}/v1/projects`, () => new Promise<Response>(() => {})));
      renderScreen();
      expect(await screen.findByText("Loading projects…")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await screen.findByTestId("projects-error")).toBeTruthy();
      expect(screen.queryByText("Drop a video to start your first project")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an empty state inviting upload when there are no projects", async () => {
    mockDb.projects.clear();
    renderScreen();
    // owner 2026-11-05: one card, the drop zone, not a second empty card
    expect(await screen.findByText("Drop a video to start your first project")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Choose video" })).toHaveLength(1);
    expect(screen.queryByText("No projects yet")).toBeNull();
    expect(screen.getByTestId("upload-dropzone").dataset.first).toBe("true");
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
      expect(await screen.findByText("Getting your video ready")).toBeTruthy();
      // server-side: analyze finishes
      p.analyze = {
        state: "succeeded",
        error: "",
        credit_cents: 50,
        credit_available: true,
      };
      await vi.advanceTimersByTimeAsync(5000);
      expect(await screen.findByText("Ready for 3D")).toBeTruthy();
      expect(vi.getTimerCount()).toBe(0); // interval cleared once nothing runs
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A file that reports a large size without allocating it. */
function bigFile(name: string, size: number): File {
  const f = new File(["x"], name, { type: "video/quicktime" });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("ProjectsScreen large uploads (Lifelike)", () => {
  it("per-method length caps from GET /v1/limits: Lifelike unlimited, old gateways 10 minutes", () => {
    expect(maxDurationFor(null, "lifelike")).toBeNull();
    expect(
      maxDurationFor(
        { methods: { lifelike: { max_source_duration_s: 0 } } },
        "lifelike",
      ),
    ).toBe(0);
    expect(maxDurationFor({ limits: { max_duration_s: 600 } }, "lifelike")).toBe(600);
    expect(maxDurationFor({}, "lifelike")).toBe(600);
  });

  it("new projects are Lifelike and the dropzone takes videos of any length", async () => {
    stubUploadFile();
    renderScreen();
    expect(await screen.findByText(/any length/)).toBeTruthy();
    await userEvent.upload(
      screen.getByLabelText("Upload video"),
      new File(["x"], "long_film.mov", { type: "video/quicktime" }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const id = (push.mock.calls[0][0] as string).slice("/projects/".length);
    expect(mockDb.projects.get(id)?.method).toBe("lifelike");
  });

  it("a push that never lands becomes a full load, with the leave guard off (owner bug 2026-11-07)", async () => {
    // the route's ?_rsc= request hangs: router.push never moves the address
    stubUploadFile();
    const assign = vi.spyOn(browserNav, "assign").mockImplementation(() => {});
    renderScreen();
    await screen.findByText(/any length/);
    await userEvent.upload(
      screen.getByLabelText("Upload video"),
      new File(["x"], "trip.mov", { type: "video/quicktime" }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const href = push.mock.calls[0][0] as string;
    expect(screen.getByText("Creating project…")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(href), {
      timeout: NAV_FALLBACK_MS + 1000,
    });
    // the full load isn't held up by "leave this page?"
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  }, 10_000);

  it("a card click that never lands becomes a full load; one that lands does nothing more", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const assign = vi.spyOn(browserNav, "assign").mockImplementation(() => {});
      renderScreen();
      const card = await screen.findByRole("link", { name: new RegExp(FIXTURE_NAME) });
      card.addEventListener("click", (e) => e.preventDefault()); // jsdom: no real navigation
      fireEvent.click(card);
      act(() => vi.advanceTimersByTime(NAV_FALLBACK_MS - 1));
      expect(assign).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(assign).toHaveBeenCalledWith(`/projects/${FIXTURE_ID}`);

      assign.mockClear();
      fireEvent.click(card);
      window.history.pushState(null, "", `/projects/${FIXTURE_ID}`);
      act(() => vi.advanceTimersByTime(NAV_FALLBACK_MS));
      expect(assign).not.toHaveBeenCalled();

      // a new-tab click is the browser's, never watched
      window.history.pushState(null, "", "/projects");
      fireEvent.click(card, { metaKey: true });
      act(() => vi.advanceTimersByTime(NAV_FALLBACK_MS));
      expect(assign).not.toHaveBeenCalled();
    } finally {
      window.history.pushState(null, "", "/");
      vi.useRealTimers();
    }
  });

  it("states Lifelike's limits only: new projects are Lifelike (S3D-01, S3D-05)", async () => {
    renderScreen();
    const limits = await screen.findByTestId("upload-limits");
    await waitFor(() =>
      expect(limits.textContent).toContain("Lifelike 3D: any length, up to 8K"),
    );
    expect(limits.textContent).not.toMatch(/Classic/);
  });

  it("shows size, progress and time left, and warns before the tab closes", async () => {
    let report: ((f: number) => void) | undefined;
    vi.spyOn(GatewayClient.prototype, "uploadFile").mockImplementation(
      (_t, _f, onProgress) => {
        report = onProgress;
        return new Promise(() => {}); // still uploading
      },
    );
    renderScreen();
    const start = Date.now();
    await userEvent.upload(
      screen.getByLabelText("Upload video"),
      bigFile("trip.mov", 2 * 1024 ** 3),
    );
    await waitFor(() => expect(report).toBeDefined());
    vi.spyOn(Date, "now").mockReturnValue(start + 120_000);
    act(() => report!(0.5));
    const detail = await screen.findByTestId("upload-detail");
    expect(detail.textContent).toContain("1.0 GB of 2.0 GB");
    expect(detail.textContent).toMatch(/about 2 min left/);

    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("asks for a resumable ticket over 100 MB and resumes after a dropped connection", async () => {
    const bodies: Record<string, unknown>[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (new URL(request.url).pathname === "/v1/uploads") {
        bodies.push((await request.clone().json()) as Record<string, unknown>);
      }
    });
    const spy = vi
      .spyOn(GatewayClient.prototype, "uploadFile")
      .mockImplementationOnce(async (_t, _f, onProgress) => {
        onProgress?.(0.4);
        throw new GatewayError("upload_failed", "upload network error", 0);
      })
      .mockImplementationOnce(async (_t, _f, onProgress) => {
        onProgress?.(1);
      });
    renderScreen();
    await userEvent.upload(
      screen.getByLabelText("Upload video"),
      bigFile("trip.mov", 300_000_000),
    );
    const resume = await screen.findByRole("button", { name: /Resume upload/ });
    expect(bodies[0]).toMatchObject({ resumable: true });
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(resume);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledTimes(2);
    // same ticket, continued where the session stands
    expect(spy.mock.calls[1][0]).toBe(spy.mock.calls[0][0]);
    expect(spy.mock.calls[1][3]).toEqual({ resume: true });
    expect(bodies).toHaveLength(1);
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
    const cards = screen.getAllByTestId("project-card");
    expect(cards[0].textContent).toContain("Pinned video");
    expect(cards[1].textContent).toContain(FIXTURE_NAME);
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
    expect(await screen.findByText("Archive this project? You can restore it later.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/is cancelled|won't be charged/);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(mockDb.projects.get(FIXTURE_ID)?.archived).toBe(true),
    );
    expect(await screen.findByText("Drop a video to start your first project")).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: new RegExp(FIXTURE_NAME) }),
    ).toBeNull();
  });

  it("active projects have no Delete; an archived one deletes for good after the in-page confirmation", async () => {
    renderScreen();
    await screen.findByRole("link", { name: new RegExp(FIXTURE_NAME) });
    expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
    mockDb.projects.get(FIXTURE_ID)!.archived = true;
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    await screen.findByRole("button", { name: "Restore project" });
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
    const dialog = await screen.findByTestId("delete-project-dialog");
    expect(dialog.textContent).toContain("Its files are removed for good.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete for good" }));
    await waitFor(() =>
      expect((mockDb.projects.get(FIXTURE_ID) as { deleted?: boolean }).deleted).toBe(true),
    );
  });

  it("shows the gateway's words when it refuses a delete", async () => {
    mockDb.projects.get(FIXTURE_ID)!.archived = true;
    server.use(
      http.post("*/v1/projects/:id/delete", () =>
        HttpResponse.json(
          { success: false, error: "project_not_archived", message: "Archive the project first, then delete it from Archived." },
          { status: 409 },
        ),
      ),
    );
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Show archived" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete project" }));
    fireEvent.click(within(await screen.findByTestId("delete-project-dialog")).getByRole("button", { name: "Delete for good" }));
    expect(await screen.findByText("Archive the project first, then delete it from Archived.")).toBeTruthy();
  });

  it("an archived sample offers Restore only, with its note", async () => {
    const p = mockDb.projects.get(FIXTURE_ID)!;
    p.archived = true;
    p.sample = true;
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Show archived" }));
    expect(await screen.findByRole("button", { name: "Restore project" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
    expect(screen.getByTestId("card-sample-note").textContent).toBe("The sample can't be deleted. Unarchive it any time.");
  });

  it("a project with a run in progress can't be archived, and says why", async () => {
    const p = mockDb.projects.get(FIXTURE_ID)!;
    p.summary = { ...(p.summary ?? {}), latest_state: "processing" } as typeof p.summary;
    mockDb.conversions.set("convactive001", {
      conversion_id: "convactive001",
      project_id: FIXTURE_ID,
      state: "processing",
      step: "production",
      params: { preset: "1080p", formats: ["sbs"] },
      quote: { amount_cents: 300, currency: "usd" },
    } as never);
    renderScreen();
    const archive = await screen.findByRole("button", { name: "Archive project" });
    expect((archive as HTMLButtonElement).disabled).toBe(true);
    expect(archive.getAttribute("aria-description")).toBe(
      "This project has a run in progress. Wait for it to finish, or cancel it, before archiving.",
    );
  });

  it("lists archived projects behind the toggle and restores back to active", async () => {
    const p = mockDb.projects.get(FIXTURE_ID);
    if (!p) throw new Error("fixture project missing");
    p.archived = true;
    renderScreen();
    expect(await screen.findByText("Drop a video to start your first project")).toBeTruthy();

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
    expect(screen.queryByText("Drop a video to start your first project")).toBeNull();
  });
});
