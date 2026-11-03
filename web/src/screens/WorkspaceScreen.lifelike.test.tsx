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
import { TOO_LONG_FOR_CLASSIC } from "@/components/workspace/MethodChooser";
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
  it("Lifelike: Media, Cut, Preview, Deliver, History", async () => {
    setMethod("lifelike");
    await renderWorkspace();
    expect(railIds()).toEqual(["media", "cut", "preview", "deliver", "history"]);
    fireEvent.click(screen.getByTestId("tab-preview"));
    expect(await screen.findByTestId("panel-lifelike-preview")).toBeTruthy();
    fireEvent.keyDown(window, { key: "4" });
    expect(await screen.findByTestId("panel-lifelike-deliver")).toBeTruthy();
  });

  it("Classic keeps today's tabs (also for projects with no stored method)", async () => {
    await renderWorkspace();
    expect(railIds()).toEqual([
      "media",
      "cut",
      "depth",
      "stereo",
      "deliver",
      "history",
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

describe("method chooser", () => {
  it("Media shows the two cards with Lifelike preselected and recommended", async () => {
    setMethod("lifelike");
    await renderWorkspace();
    const chooser = await screen.findByTestId("method-chooser");
    expect(within(chooser).getByText("How should we make it 3D?")).toBeTruthy();
    expect(
      within(chooser).getByText("You can switch later. Same price either way."),
    ).toBeTruthy();
    const lifelike = within(screen.getByTestId("method-card-lifelike"));
    expect((lifelike.getByRole("radio") as HTMLInputElement).checked).toBe(true);
    expect(lifelike.getByText("Recommended")).toBeTruthy();
    expect(
      within(screen.getByTestId("method-card-classic")).queryByText("Recommended"),
    ).toBeNull();
  });

  it("switching to Classic PATCHes the method and swaps the rail", async () => {
    setMethod("lifelike");
    await renderWorkspace();
    fireEvent.click(
      within(screen.getByTestId("method-card-classic")).getByRole("radio"),
    );
    await waitFor(() => expect(railIds()).toContain("depth"));
    expect(mockDb.projects.get(PID)!.method).toBe("classic");
    // the header switch follows
    const sw = within(screen.getByTestId("method-switch"));
    expect(
      (sw.getByRole("radio", { name: "Classic 3D" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("the header switch works from any page", async () => {
    await renderWorkspace("#tab=history");
    fireEvent.click(
      within(screen.getByTestId("method-switch")).getByRole("radio", {
        name: "Lifelike 3D",
      }),
    );
    await waitFor(() => expect(railIds()).toContain("preview"));
    expect(mockDb.projects.get(PID)!.method).toBe("lifelike");
  });

  it("a video too long for Classic gets a friendly note and stays Lifelike", async () => {
    setMethod("lifelike");
    mockDb.methodMaxDurationS.classic = 60; // the fixture runs ~149 s
    await renderWorkspace();
    fireEvent.click(
      within(screen.getByTestId("method-card-classic")).getByRole("radio"),
    );
    expect(
      await within(screen.getByTestId("method-chooser")).findByText(
        TOO_LONG_FOR_CLASSIC,
      ),
    ).toBeTruthy();
    expect(railIds()).toContain("preview");
    expect(mockDb.projects.get(PID)!.method).toBe("lifelike");
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
    await renderWorkspace("#tab=history");
    const label = async (id: string) =>
      within(await screen.findByTestId(`history-${id}`)).getByTestId(
        "history-method",
      ).textContent;
    expect(await label("c00000000old")).toBe("Classic 3D");
    expect(await label("c00000000new")).toBe("Lifelike 3D");
  });
});
