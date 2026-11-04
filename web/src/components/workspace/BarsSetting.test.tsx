/**
 * Black bars (owner request 2026-11-04): Overview says where they are and
 * offers Remove bars (recommended) / Keep them; Make 3D has the same
 * setting with the size it makes; hidden when the gateway says nothing.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LifelikeDeliverPanel } from "@/components/steps/LifelikeDeliverPanel";
import type { Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { barSides, barsNotice, sizeWithoutBars } from "@/lib/bars";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { OverviewTab } from "./OverviewTab";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const PID = (projectFixture as unknown as Project).project_id;

/** The seeded project, 3840×2160 with bars at the top and bottom. */
function barred(over: Partial<Project> = {}): Project {
  const p = mockDb.projects.get(PID)!;
  p.method = "lifelike";
  p.probe = { ...p.probe!, width: 3840, height: 2160 };
  p.crop = "3840:1600:0:280";
  p.has_bars = true;
  p.remove_bars = true;
  Object.assign(p, over);
  return structuredClone(p);
}

describe("black bars: the words", () => {
  it("says where the bars are", () => {
    const probe = { width: 3840, height: 2160 } as Project["probe"];
    expect(barSides({ has_bars: true, crop: "3840:1600:0:280", probe })).toBe("top_bottom");
    expect(barSides({ has_bars: true, crop: "2880:2160:480:0", probe })).toBe("sides");
    expect(barSides({ has_bars: true, crop: "2880:1600:480:280", probe })).toBe("all");
    expect(barSides({ crop: "3840:1600:0:280", probe })).toBeNull(); // an older gateway
    expect(barsNotice("top_bottom", true)).toBe(
      "Black bars found at the top and bottom of your video. We'll remove them so your 3D fills the frame.",
    );
    expect(barsNotice("sides", true)).toMatch(/^Black bars found on the left and right/);
    expect(barsNotice("all", true)).toMatch(/^Black bars found on all sides/);
    expect(sizeWithoutBars({ width: 3840, height: 2160 }, "3840:1600:0:280", { width: 3840, height: 2160 })).toEqual({
      width: 3840,
      height: 1600,
    });
  });
});

describe("Overview: the black bars notice", () => {
  it("tells the person and saves Keep them at once", async () => {
    const onUpdated = vi.fn();
    render(
      <AuthProvider>
        <OverviewTab project={barred()} onNavigate={() => {}} onProjectUpdated={onUpdated} />
      </AuthProvider>,
    );
    const notice = screen.getByTestId("bars-notice");
    expect(notice.textContent).toContain(
      "Black bars found at the top and bottom of your video. We'll remove them so your 3D fills the frame.",
    );
    const remove = within(notice).getByRole("button", { name: "Remove bars (recommended)" });
    expect(remove.getAttribute("aria-pressed")).toBe("true");
    expect(within(notice).getByTestId("bars-before-after")).toBeTruthy();
    fireEvent.click(within(notice).getByRole("button", { name: "Keep them" }));
    await waitFor(() => expect(mockDb.projects.get(PID)!.remove_bars).toBe(false));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ remove_bars: false }));
    expect(within(notice).getByRole("button", { name: "Keep them" }).getAttribute("aria-pressed")).toBe("true");
    expect(notice.textContent).toContain("Your 3D keeps them.");
  });

  it("left and right for pillarbox", () => {
    render(
      <AuthProvider>
        <OverviewTab project={barred({ crop: "2880:2160:480:0" })} onNavigate={() => {}} onProjectUpdated={() => {}} />
      </AuthProvider>,
    );
    expect(screen.getByTestId("bars-notice").textContent).toMatch(/on the left and right of your video/);
  });

  it("hidden when the gateway doesn't say has_bars", () => {
    render(
      <AuthProvider>
        <OverviewTab project={barred({ has_bars: undefined })} onNavigate={() => {}} onProjectUpdated={() => {}} />
      </AuthProvider>,
    );
    expect(screen.queryByTestId("bars-notice")).toBeNull();
  });
});

describe("Make 3D: the black bars setting", () => {
  it("a toggle with the size it makes, saved at once", async () => {
    const onChanged = vi.fn();
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={barred()} onProjectChanged={onChanged} />
      </AuthProvider>,
    );
    const toggle = screen.getByTestId("bars-toggle");
    const box = within(toggle).getByRole("checkbox", { name: /Remove black bars/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(within(toggle).getByTestId("bars-toggle-help").textContent).toContain("3840×1600 instead of 3840×2160");
    fireEvent.click(box);
    await waitFor(() => expect(mockDb.projects.get(PID)!.remove_bars).toBe(false));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(box.checked).toBe(false);
    expect(within(toggle).getByTestId("bars-toggle-help").textContent).toBe("The 3D keeps the black bars, at 3840×2160.");
  });

  it("not there without bars", () => {
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={barred({ has_bars: false })} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    expect(screen.queryByTestId("bars-toggle")).toBeNull();
  });
});
