/**
 * Onboarding (owner-approved canvas, 2026-11-04) against the MSW gateway:
 * the welcome saves the headsets on the account and logs our own event,
 * the getting-started list reads the account, the sample project, the
 * workspace tips and first-time hints are remembered on the account.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { checklistSteps } from "@/components/onboarding/GetStarted";
import { FirstTimeHint } from "@/components/onboarding/FirstTimeHint";
import { WorkspaceTips } from "@/components/onboarding/WorkspaceTips";
import { LifelikeDeliverPanel } from "@/components/steps/LifelikeDeliverPanel";
import type { Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { resetAccountSettingsCache } from "@/lib/useAccountSettings";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import ProjectsScreen from "@/screens/ProjectsScreen";

import projectFixture from "../../../fixtures/project.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  resetAccountSettingsCache();
  // a brand-new account
  mockDb.accountSettings = { lifelike_intro: true, locale: null, headsets: null, hints_seen: [], onboarding: {} };
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function renderProjects() {
  return render(
    <AuthProvider>
      <BillingProvider>
        <ProjectsScreen />
      </BillingProvider>
    </AuthProvider>,
  );
}

describe("welcome after sign-up", () => {
  it("asks where they watch, saves it on the account, logs the event, then offers the sample", async () => {
    mockDb.projects.clear();
    mockDb.sampleSeeding = true;
    renderProjects();
    const quest = await screen.findByTestId("welcome-device-quest");
    fireEvent.click(quest);
    fireEvent.click(screen.getByTestId("welcome-device-avp"));
    expect(quest.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("welcome-next"));
    await waitFor(() => expect(mockDb.accountSettings.headsets).toEqual(["quest", "avp"]));
    await waitFor(() => expect(mockDb.events.at(-1)?.name).toBe("onboarding_headsets"));
    expect(mockDb.events.at(-1)?.props).toMatchObject({ devices: ["quest", "avp"], plan: "none" });
    expect(await screen.findByText("Three steps, and you only pay at the end.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("welcome-next"));
    expect(await screen.findByTestId("welcome-sample")).toBeTruthy();
    fireEvent.click(screen.getByTestId("welcome-later"));
    await waitFor(() => expect(mockDb.accountSettings.onboarding.welcome_done).toBe(true));
    // the sample sits in Projects, marked and never billed
    expect(await screen.findByTestId("card-sample")).toBeTruthy();
    expect(screen.getByTestId("card-sample-note").textContent).toBe(
      "A finished example to look around. It's not billed and you can remove it.",
    );
    // getting started: the headset step is done, adding a video is next
    const list = await screen.findByTestId("get-started");
    expect(screen.getByTestId("get-started-progress").textContent).toBe("1 of 5 done");
    expect(screen.getByTestId("get-started-headset").textContent).toContain("Meta Quest, Apple Vision Pro");
    expect(list.textContent).toContain("Next");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(mockDb.accountSettings.onboarding.checklist_hidden).toBe(true));
    expect(screen.queryByTestId("get-started")).toBeNull();
  });

  it("never shows to someone who already has projects", async () => {
    renderProjects();
    expect(await screen.findByTestId("get-started")).toBeTruthy();
    expect(screen.queryByTestId("welcome")).toBeNull();
  });
});

describe("getting-started steps", () => {
  it("follow the account and the gateway's steps", () => {
    const steps = checklistSteps({
      lifelike_intro: true,
      lifelike_intro_editable: false,
      locale: null,
      headsets: ["avp"],
      onboarding: { steps: { first_video: true, first_preview: true } },
    });
    expect(steps.map((s) => s.done)).toEqual([true, true, true, false, false]);
  });
});

describe("Make 3D remembers the headsets", () => {
  it("preselects the welcome's answer", async () => {
    mockDb.accountSettings.headsets = ["avp"];
    const p = mockDb.projects.get((projectFixture as unknown as Project).project_id)!;
    p.method = "lifelike";
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={structuredClone({ ...p, conversions: [] })} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /Apple Vision Pro/ }) as HTMLInputElement).checked).toBe(true));
    expect((screen.getByRole("checkbox", { name: /Meta Quest/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe("tips and hints", () => {
  it("four workspace tips, saved as done on the account", async () => {
    render(
      <AuthProvider>
        <WorkspaceTips />
      </AuthProvider>,
    );
    expect((await screen.findByTestId("workspace-tip")).textContent).toContain("Everything about your video");
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId("tip-next"));
    expect(screen.getByTestId("workspace-tip").textContent).toContain("Your 3D files");
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(mockDb.accountSettings.onboarding.tips_done).toBe(true));
    expect(screen.queryByTestId("workspace-tip")).toBeNull();
  });

  it("a first-time hint shows once and is remembered on the account", async () => {
    render(
      <AuthProvider>
        <FirstTimeHint id="usage" />
      </AuthProvider>,
    );
    expect((await screen.findByTestId("hint-usage")).textContent).toContain("Every run with its price");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this tip" }));
    await waitFor(() => expect(mockDb.accountSettings.hints_seen).toContain("usage"));
    expect(screen.queryByTestId("hint-usage")).toBeNull();
  });
});
