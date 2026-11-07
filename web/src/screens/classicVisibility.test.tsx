/**
 * Classic 3D for new users (owner 2026-11-07): an account with no Classic
 * project or run never sees Classic (no method chooser, no Classic chip,
 * badge, tag or move offer; new projects are Lifelike), while an account
 * with a Classic project keeps everything exactly as it was. Everything
 * Classic in the web hangs off a project's own method (/v1/projects sends
 * it on every project), so "has Classic" needs no account flag.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import projectFixture from "../../fixtures/project.json";
import type { Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import ProjectsScreen from "@/screens/ProjectsScreen";
import WorkspaceScreen from "@/screens/WorkspaceScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/projects",
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
vi.mock("@/components/steps/LifelikePreviewPanel", () => ({ LifelikePreviewPanel: fakePanel("lifelike-preview") }));
vi.mock("@/components/steps/LifelikeDeliverPanel", () => ({ LifelikeDeliverPanel: fakePanel("lifelike-deliver") }));

beforeAll(() => {
  HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("pause"));
  };
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const PID = (projectFixture as unknown as Project).project_id;

/** every project the account has, Lifelike */
function newAccount(): void {
  for (const p of mockDb.projects.values()) p.method = "lifelike";
}

const CLASSIC = /Classic|Older method|Convert with Lifelike/;

describe("a new account (no Classic anywhere)", () => {
  it("Projects: no Classic chip or word, from the first paint on", async () => {
    newAccount();
    render(
      <AuthProvider>
        <ProjectsScreen />
      </AuthProvider>,
    );
    // while the list loads, and once it's there
    expect(document.body.textContent).not.toMatch(CLASSIC);
    await screen.findAllByTestId("project-card", {}, { timeout: 4000 });
    expect(document.body.textContent).not.toMatch(CLASSIC);
  });

  it("a project: the Lifelike rail, no method chooser, tag or move offer", async () => {
    newAccount();
    render(
      <AuthProvider>
        <WorkspaceScreen projectId={PID} />
      </AuthProvider>,
    );
    expect(document.body.textContent).not.toMatch(CLASSIC);
    await screen.findAllByRole("tab");
    const badge = await screen.findByTestId("method-badge");
    expect(badge.textContent).toContain("Lifelike 3D");
    expect(screen.queryByTestId("method-tag-classic")).toBeNull();
    expect(screen.queryAllByRole("tab").map((t) => t.getAttribute("data-testid"))).not.toContain("tab-depth");
    await waitFor(() => expect(document.body.textContent).not.toMatch(CLASSIC));
  });
});

describe("an account with a Classic project (unchanged)", () => {
  it("Projects: its card still says Classic 3D · Older method", async () => {
    mockDb.projects.get(PID)!.method = "classic";
    render(
      <AuthProvider>
        <ProjectsScreen />
      </AuthProvider>,
    );
    const cards = await screen.findAllByTestId("project-card", {}, { timeout: 4000 });
    const classic = cards.find((c) => /Classic 3D/.test(c.textContent ?? ""));
    expect(classic).toBeTruthy();
    expect(within(classic!).getByText(/Older method/)).toBeTruthy();
  });

  it("the Classic project: Classic rail, badge and the move to Lifelike", async () => {
    mockDb.projects.get(PID)!.method = "classic";
    render(
      <AuthProvider>
        <WorkspaceScreen projectId={PID} />
      </AuthProvider>,
    );
    await screen.findAllByRole("tab");
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("data-testid"))).toEqual(
      expect.arrayContaining(["tab-depth", "tab-look", "tab-make"]),
    );
    const badge = await screen.findByTestId("method-badge");
    expect(badge.textContent).toContain("Classic 3D");
    expect(within(badge).getByRole("button", { name: /Lifelike/ })).toBeTruthy();
  });
});
