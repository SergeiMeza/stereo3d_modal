/**
 * Workspace wiring for the per-project method: the rail per method, the
 * method chooser on Media and the header switch (PATCH, friendly
 * source_too_long_for_method), and the History method labels.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import type { Conversion, Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import WorkspaceScreen from "@/screens/WorkspaceScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/x",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

function fakePanel(name: string) {
  return function FakePanel() {
    return <div data-testid={`panel-${name}`} />;
  };
}
vi.mock("@/components/steps/DepthPanel", () => ({ DepthPanel: fakePanel("depth") }));
vi.mock("@/components/steps/StereoPanel", () => ({ StereoPanel: fakePanel("stereo") }));
vi.mock("@/components/steps/DeliverPanel", () => ({ DeliverPanel: fakePanel("classic-deliver") }));
vi.mock("@/components/steps/LifelikePreviewPanel", () => ({
  LifelikePreviewPanel: fakePanel("lifelike-preview"),
}));
vi.mock("@/components/steps/LifelikeDeliverPanel", () => ({
  LifelikeDeliverPanel: fakePanel("lifelike-deliver"),
}));

beforeAll(() => {
  HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("pause"));
  };
});
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  window.history.replaceState(null, "", window.location.pathname);
});
afterAll(() => server.close());

const PID = (projectFixture as unknown as Project).project_id;

function setMethod(method: "lifelike" | "classic") {
  mockDb.projects.get(PID)!.method = method;
}

async function renderWorkspace(hash = ""): Promise<void> {
  window.history.replaceState(null, "", hash);
  render(
    <AuthProvider>
      <WorkspaceScreen projectId={PID} />
    </AuthProvider>,
  );
  await screen.findAllByRole("tab");
}

function railIds(): string[] {
  return screen
    .getAllByRole("tab")
    .map((t) => t.getAttribute("data-testid")!.replace("tab-", ""));
}

describe("tabs per method", () => {
  it("Lifelike: Overview, Scenes, Preview, Make 3D, Files", async () => {
    setMethod("lifelike");
    await renderWorkspace();
    expect(railIds()).toEqual(["overview", "scenes", "preview", "make", "files"]);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Overview",
      "Scenes",
      "Preview",
      "Make 3D",
      "Files",
    ]);
    fireEvent.click(screen.getByTestId("tab-preview"));
    expect(await screen.findByTestId("panel-lifelike-preview")).toBeTruthy();
    fireEvent.keyDown(window, { key: "4" });
    expect(await screen.findByTestId("panel-lifelike-deliver")).toBeTruthy();
  });

  it("Classic keeps today's tabs (also for projects with no stored method)", async () => {
    await renderWorkspace();
    expect(railIds()).toEqual([
      "overview",
      "scenes",
      "depth",
      "look",
      "make",
      "files",
    ]);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Overview",
      "Scenes",
      "Depth",
      "3D look",
      "Make 3D",
      "Files",
    ]);
    fireEvent.keyDown(window, { key: "5" });
    expect(await screen.findByTestId("panel-classic-deliver")).toBeTruthy();
  });

  it("a Classic link (#tab=depth) opens Preview on a Lifelike project", async () => {
    setMethod("lifelike");
    await renderWorkspace("#tab=depth");
    expect(await screen.findByTestId("panel-lifelike-preview")).toBeTruthy();
    expect(screen.getByTestId("tab-preview").getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});

describe("no method chooser (S3D-01, S3D-14, S3D-30, S3D-44)", () => {
  it("a Lifelike project shows its summary and never names Classic", async () => {
    setMethod("lifelike");
    await renderWorkspace();
    await screen.findByTestId("overview-summary");
    expect(screen.queryByTestId("method-chooser")).toBeNull();
    expect(screen.queryByTestId("move-to-lifelike-offer")).toBeNull();
    expect(screen.getByTestId("overview-method").textContent).toBe("Lifelike 3D");
    await waitFor(() =>
      expect(screen.getByTestId("overview-price").textContent).toMatch(
        /^\$\d+\.\d\d · about /,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("overview-main").textContent).toMatch(
        /^Preview a moment · \$\d+\.\d\d$/,
      ),
    );
    expect(document.body.textContent).not.toMatch(/Classic|Older method|Red-cyan/);
    expect(
      within(screen.getByTestId("method-badge")).queryByText("Move to Lifelike 3D"),
    ).toBeNull();
  });

  it("a Classic project keeps its Older method tag and offers the one-way move with both prices", async () => {
    const quotes: Record<string, unknown>[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/quotes")) {
        quotes.push((await request.clone().json()) as Record<string, unknown>);
      }
    });
    await renderWorkspace(); // fixture: Classic, no runs
    expect(screen.getByTestId("overview-method").textContent).toBe(
      "Classic 3D· Older method",
    );
    const offer = await screen.findByTestId("move-to-lifelike-offer");
    await waitFor(() =>
      expect(offer.textContent).toMatch(
        /^✦Move to Lifelike 3D: \$\d+\.\d\d, about .+ for this video\./,
      ),
    );
    // a fair comparison: Lifelike priced at Classic's own quality, its
    // higher size on a second line
    const classicQuote = quotes.find((q) => q.method === "classic");
    expect(
      quotes.some((q) => q.method === "lifelike" && q.preset === classicQuote?.preset),
    ).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId("move-offer-higher").textContent).toMatch(
        /^or .+ for \$\d+\.\d\d$/,
      ),
    );
    // beside its own Classic price
    await waitFor(() =>
      expect(screen.getByTestId("overview-price").textContent).toMatch(/^\$\d+\.\d\d/),
    );
    fireEvent.click(within(offer).getByRole("button", { name: "Move" }));
    const dialog = await screen.findByTestId("move-to-lifelike-dialog");
    expect(within(dialog).getByText("Move this project to Lifelike 3D?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Your Classic files stay in Files. You can't move back to Classic.",
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(within(dialog).getByTestId("move-lifelike-price").textContent).toMatch(
        /^\$\d+\.\d\d$/,
      ),
    );
    await waitFor(() =>
      expect(within(dialog).getByTestId("move-classic-price").textContent).toMatch(
        /^\$\d+\.\d\d$/,
      ),
    );
    expect(mockDb.projects.get(PID)!.method).toBeUndefined(); // not yet
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Lifelike 3D" }));
    await waitFor(() => expect(railIds()).toContain("preview"));
    expect(mockDb.projects.get(PID)!.method).toBe("lifelike");
    await waitFor(() => expect(screen.queryByTestId("move-to-lifelike-offer")).toBeNull());
  });

  it("a Classic project with runs gets the offer and the header move", async () => {
    mockDb.conversions.set("c0000000run1", {
      conversion_id: "c0000000run1",
      state: "succeeded",
      kind: "video",
      project_id: PID,
      step: "production",
      params: { preset: "1080p", formats: ["sbs"] },
      quote: { amount_cents: 500, currency: "usd" },
      progress: 1,
      outputs: ["sbs"],
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    await renderWorkspace();
    expect(await screen.findByTestId("move-to-lifelike-offer")).toBeTruthy();
    expect(within(screen.getByTestId("method-badge")).getByText("Older method")).toBeTruthy();
    fireEvent.click(
      within(screen.getByTestId("method-badge")).getByRole("button", {
        name: "Move to Lifelike 3D",
      }),
    );
    expect(await screen.findByTestId("move-to-lifelike-dialog")).toBeTruthy();
  });

  it("a Classic project past Classic's length cap says so in its price", async () => {
    mockDb.methodMaxDurationS.classic = 60; // the fixture runs ~149 s
    await renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("overview-price").textContent).toBe(
        "This video is longer than Classic 3D can take.",
      ),
    );
  });
});

describe("method availability", () => {
  it("hides the move when Lifelike isn't available", async () => {
    mockDb.methodAvailable.lifelike = false;
    await renderWorkspace();
    await waitFor(() =>
      expect(
        within(screen.getByTestId("method-badge")).queryByText("Move to Lifelike 3D"),
      ).toBeNull(),
    );
    expect(screen.queryByTestId("method-chooser")).toBeNull();
    expect(railIds()).toContain("depth");
  });
});

describe("History", () => {
  it("labels each run with its method", async () => {
    const base: Conversion = {
      conversion_id: "c00000000old",
      state: "succeeded",
      kind: "video",
      project_id: PID,
      step: "production",
      params: { preset: "1080p", formats: ["sbs"] },
      quote: { amount_cents: 500, currency: "usd" },
      progress: 1,
      outputs: ["sbs"],
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    };
    mockDb.conversions.set(base.conversion_id, base);
    mockDb.conversions.set("c00000000new", {
      ...base,
      conversion_id: "c00000000new",
      method: "lifelike",
      created_at: "2026-11-01T00:00:00Z",
    });
    await renderWorkspace("#tab=files");
    const label = async (id: string) =>
      within(await screen.findByTestId(`history-${id}`)).getByTestId(
        "history-method",
      ).textContent;
    expect(await label("c00000000old")).toBe("Classic 3D");
    expect(await label("c00000000new")).toBe("Lifelike 3D");
  });
});
