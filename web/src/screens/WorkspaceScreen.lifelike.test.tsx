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

describe("method chooser (S3D-01, S3D-14, S3D-30, S3D-44)", () => {
  it("Overview shows both methods with this video's price and time, Lifelike preselected and recommended", async () => {
    setMethod("lifelike");
    await renderWorkspace();
    const chooser = await screen.findByTestId("method-chooser");
    expect(within(chooser).getByText("How should we make it 3D?")).toBeTruthy();
    expect(within(chooser).queryByText(/Same price either way/)).toBeNull();
    const lifelike = within(screen.getByTestId("method-card-lifelike"));
    expect((lifelike.getByRole("radio") as HTMLInputElement).checked).toBe(true);
    expect(lifelike.getByText("Recommended")).toBeTruthy();
    // S3D-46: the newest 3D technology
    expect(lifelike.getByTestId("method-tag-new").textContent).toBe("New");
    expect(lifelike.getByTestId("method-eyebrow").textContent).toBe(
      "Our newest 3D technology",
    );
    expect(
      lifelike.getByText(
        "Rebuilds every moment of your video as a real 3D scene, then films it again for each eye. The most natural depth and clean edges, in a fraction of the time.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("method-card-lifelike").className).toContain(
      "ll-edge",
    );
    expect(screen.getByTestId("method-card-classic").className).not.toContain(
      "ll-edge",
    );
    const classic = within(screen.getByTestId("method-card-classic"));
    expect(classic.getByText("Classic 3D")).toBeTruthy();
    expect(classic.getByTestId("method-tag-classic").textContent).toBe("Older method");
    expect(
      classic.getByText("Adds depth to your footage, with manual control over each step."),
    ).toBeTruthy();
    expect(classic.queryByText("Recommended")).toBeNull();
    expect(classic.queryByTestId("method-tag-new")).toBeNull();
    // both prices for this video, at the best quality each method reaches
    await waitFor(() =>
      expect(screen.getByTestId("method-price-lifelike").textContent).toMatch(
        /^\$\d+\.\d\d· about .+ · any length, up to 8K$/,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("method-price-classic").textContent).toMatch(
        /^\$\d+\.\d\d· about .+ · up to 10 minutes, up to 4K$/,
      ),
    );
    // the summary prices the project's own method at its best quality and
    // never names Red-cyan
    expect(screen.getByTestId("overview-price").textContent).toBe(
      screen
        .getByTestId("method-price-lifelike")
        .textContent!.replace(/ · any length, up to 8K$/, "")
        .replace("·", " ·"),
    );
    expect(screen.getByTestId("overview-summary").textContent).not.toMatch(
      /Red-cyan/,
    );
    await waitFor(() =>
      expect(screen.getByTestId("overview-main").textContent).toMatch(
        /^Preview a moment · \$\d+\.\d\d$/,
      ),
    );
    expect(screen.getByTestId("method-price-lifelike").textContent).not.toBe(
      screen.getByTestId("method-price-classic").textContent,
    );
  });

  it("a Lifelike project never moves back: the gateway's refusal reads as a sentence", async () => {
    setMethod("lifelike");
    await renderWorkspace();
    expect(
      within(screen.getByTestId("method-badge")).queryByText("Move to Lifelike 3D"),
    ).toBeNull();
    fireEvent.click(
      within(screen.getByTestId("method-card-classic")).getByRole("radio"),
    );
    expect(
      await within(screen.getByTestId("method-chooser")).findByText(
        /can't move back to Classic 3D/,
      ),
    ).toBeTruthy();
    expect(mockDb.projects.get(PID)!.method).toBe("lifelike");
    expect(railIds()).toContain("preview");
  });

  it("Classic → Lifelike asks first, then moves the project and swaps the rail", async () => {
    await renderWorkspace(); // fixture: Classic, no runs
    fireEvent.click(
      within(screen.getByTestId("method-card-lifelike")).getByRole("radio"),
    );
    const dialog = await screen.findByTestId("move-to-lifelike-dialog");
    expect(within(dialog).getByText("Move this project to Lifelike 3D?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Your Classic files stay in Files. You can't move back to Classic.",
      ),
    ).toBeTruthy();
    // this video's price and time under both methods
    await waitFor(() =>
      expect(within(dialog).getByTestId("move-lifelike-price").textContent).toMatch(
        /^\$\d+\.\d\d$/,
      ),
    );
    expect(within(dialog).getByTestId("move-classic-price").textContent).toMatch(
      /^\$\d+\.\d\d$/,
    );
    expect(mockDb.projects.get(PID)!.method).toBeUndefined(); // not yet
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Lifelike 3D" }));
    await waitFor(() => expect(railIds()).toContain("preview"));
    expect(mockDb.projects.get(PID)!.method).toBe("lifelike");
  });

  it("a Classic project with runs gets the one-line offer, and the header move", async () => {
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
    expect(screen.queryByTestId("method-chooser")).toBeNull();
    const offer = await screen.findByTestId("move-to-lifelike-offer");
    await waitFor(() =>
      expect(offer.textContent).toMatch(
        /Move to Lifelike 3DNew\$\d+\.\d\d, about .+ for this video\.Move$/,
      ),
    );
    fireEvent.click(
      within(screen.getByTestId("method-badge")).getByRole("button", {
        name: "Move to Lifelike 3D",
      }),
    );
    expect(await screen.findByTestId("move-to-lifelike-dialog")).toBeTruthy();
  });

  it("Classic can't price a video past its length cap", async () => {
    setMethod("lifelike");
    mockDb.methodMaxDurationS.classic = 60; // the fixture runs ~149 s
    await renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("method-price-classic").textContent).toBe(
        "This video is longer than Classic 3D can take.",
      ),
    );
  });
});

describe("method availability", () => {
  it("hides the chooser and the move when Lifelike isn't available", async () => {
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
