/**
 * Frame rates above 30 fps need a Business or Studio plan (owner
 * 2026-11-04): a source above 30 fps makes the rate a required choice with
 * a price per option, locked options without a plan, and the chosen rate
 * beside the button.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { fpsDivisions, needsFpsChoice } from "./frameRate";
import { LifelikeDeliverPanel } from "./LifelikeDeliverPanel";
import { LifelikePreviewPanel } from "./LifelikePreviewPanel";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 30 }));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  mockDb.fpsCap = true;
  resetPricingCache();
  clearStepQuotes();
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const PID = (projectFixture as unknown as Project).project_id;

function project(fps: number): Project {
  const p = mockDb.projects.get(PID)!;
  p.method = "lifelike";
  p.probe = {
    ...p.probe!,
    fps,
    fps_rational: `${fps}/1`,
    num_frames: Math.round(p.probe!.duration_s * fps),
  };
  return structuredClone({ ...p, conversions: [] });
}

function business(): void {
  mockDb.billing.plan = {
    plan: "business", name: "Business", status: "active", active: true, monthly_cents: 29900,
    credit_cents: 40000, credit_left_cents: 40000, cancel_at_period_end: false,
  };
}

const main = () => screen.getByTestId("checkout-main") as HTMLButtonElement;

describe("frame-rate choices", () => {
  it("offers whole divisions of the source down to about 24", () => {
    expect(fpsDivisions(60)).toEqual([60, 30]);
    expect(fpsDivisions(120)).toEqual([120, 60, 40, 30, 24]);
    expect(fpsDivisions(59.94)).toEqual([59.94, 29.97]);
    expect(needsFpsChoice(30)).toBe(false);
    expect(needsFpsChoice(29.97)).toBe(false);
    expect(needsFpsChoice(50)).toBe(true);
  });
});

describe("Make 3D with a 60 fps source, no plan", () => {
  it("requires a pick, locks 60 fps behind a plan, and repeats the rate by the button", async () => {
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={project(60)} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    expect(screen.getByTestId("fps-section").textContent).toContain("Your video is 60 fps");
    // nothing preselected: the button waits
    expect(main().disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId("fps-30").textContent).toMatch(/^30 fps ?· \$\d/));
    await waitFor(() =>
      expect(screen.getByTestId("fps-60").textContent).toBe("60 fps· Business or Studio plan"),
    );
    expect((screen.getByTestId("fps-60") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("fps-choice").textContent).toContain(
      "Frame rates above 30 fps come with Business and Studio plans.",
    );
    fireEvent.click(screen.getByTestId("fps-30"));
    await waitFor(() => expect(main().disabled).toBe(false));
    expect(screen.getByTestId("run-summary").textContent).toMatch(/^4K · 30 fps · \d+ min$/);
  });
});

describe("Make 3D with a 120 fps source, Business plan", () => {
  it("offers the gateway's allowed rates, all unlocked", async () => {
    business();
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={project(120)} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    for (const r of [120, 60, 40, 30, 24]) {
      await waitFor(() =>
        expect(screen.getByTestId(`fps-${r}`).textContent).toMatch(new RegExp(`^${r} fps ?· \\$\\d`)),
      );
    }
    expect(screen.queryByText(/Business or Studio plan/)).toBeNull();
    fireEvent.click(screen.getByTestId("fps-60"));
    await waitFor(() => expect(main().disabled).toBe(false));
    expect(screen.getByTestId("run-summary").textContent).toMatch(/^4K · 60 fps · \d+ min$/);
  });
});

describe("Preview with a 60 fps source", () => {
  it("asks for the rate instead of Quick look, and waits for it", async () => {
    render(
      <AuthProvider>
        <LifelikePreviewPanel project={project(60)} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    expect(screen.queryByText("Quick look")).toBeNull();
    expect(main().disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId("fps-30").textContent).toMatch(/^30 fps ?· /));
    fireEvent.click(screen.getByTestId("fps-30"));
    await waitFor(() => expect(main().disabled).toBe(false));
  });
});
