/**
 * Onboarding (owner-approved canvas, 2026-11-04) against the MSW gateway:
 * the welcome saves the headsets on the account and logs our own event,
 * the getting-started list reads the account, the sample project, the
 * workspace tips and first-time hints are remembered on the account.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { checklistSteps } from "@/components/onboarding/GetStarted";
import { FirstTimeHint } from "@/components/onboarding/FirstTimeHint";
import { WorkspaceTips } from "@/components/onboarding/WorkspaceTips";
import { LifelikeDeliverPanel } from "@/components/steps/LifelikeDeliverPanel";
import type { Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { resetPricingCache } from "@/lib/api/usePricing";
import { resetProForTests } from "@/lib/pro/usePro";
import { accountSettingsAtom, resetAccountSettingsCache } from "@/lib/useAccountSettings";
import { appStore } from "@/lib/state/stores";
import { loadProjectsAtom, projectListAtom } from "@/components/projects/projectsAtoms";
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
  mockDb.accountSettings = { lifelike_intro: true, locale: null, headsets: null, hints_seen: [], onboarding: {}, dismissed: {} };
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
    expect(await screen.findByText("Three steps. You see the price before you pay.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("welcome-next"));
    expect(await screen.findByTestId("welcome-sample")).toBeTruthy();
    fireEvent.click(screen.getByTestId("welcome-later"));
    await waitFor(() => expect(mockDb.accountSettings.onboarding.welcome_done).toBe(true));
    // the sample sits in Projects, marked and never billed
    expect(await screen.findByTestId("card-sample")).toBeTruthy();
    expect(screen.getByTestId("card-sample-note").textContent).toBe(
      "A finished example to look around. It's not billed and you can archive it.",
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

  it("an older account with its own projects and no saved welcome sees it once (owner 2026-11-05)", async () => {
    // the fixture account already has projects of its own
    expect([...mockDb.projects.values()].some((p) => p.sample !== true)).toBe(true);
    renderProjects();
    const welcome = await screen.findByTestId("welcome");
    expect(welcome).toBeTruthy();
    // closing it saves welcome_done, so it never comes back
    fireEvent.keyDown(welcome, { key: "Escape" });
    await waitFor(() => expect(mockDb.accountSettings.onboarding.welcome_done).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("welcome")).toBeNull());
    cleanup();
    resetAccountSettingsCache();
    renderProjects();
    expect(await screen.findByTestId("get-started")).toBeTruthy();
    expect(screen.queryByTestId("welcome")).toBeNull();
  });

  it("an account that saved the welcome never sees it again", async () => {
    mockDb.accountSettings.onboarding = { welcome_done: true };
    renderProjects();
    expect(await screen.findByTestId("get-started")).toBeTruthy();
    expect(screen.queryByTestId("welcome")).toBeNull();
  });
});

describe("no Skip; the welcome until it's saved (owner 2026-11-07)", () => {
  it("a brand-new account: its first Projects list brings the sample, and the welcome has no Skip", async () => {
    mockDb.projects.clear();
    mockDb.sampleSeeding = true;
    let lists = 0;
    server.events.on("request:start", ({ request }) => {
      if (request.method === "GET" && new URL(request.url).pathname === "/v1/projects") lists += 1;
    });
    renderProjects();
    await screen.findByTestId("welcome-device-quest");
    // the gateway adds the sample inside GET /v1/projects (no other call)
    expect(lists).toBeGreaterThan(0);
    expect(await screen.findByTestId("card-sample")).toBeTruthy();
    expect(screen.queryByText("Skip")).toBeNull();
    fireEvent.click(screen.getByTestId("welcome-next"));
    expect(screen.queryByText("Skip")).toBeNull();
    // the last step offers the sample; nothing jumps past the steps
    fireEvent.click(screen.getByTestId("welcome-next"));
    expect(await screen.findByTestId("welcome-sample")).toBeTruthy();
    expect(screen.queryByText("Skip")).toBeNull();
    server.events.removeAllListeners();
  });

  it("closing the tab mid-way: the welcome shows again; finishing it saves welcome_done and ends it", async () => {
    mockDb.projects.clear();
    mockDb.sampleSeeding = true;
    const first = renderProjects();
    await screen.findByTestId("welcome-device-quest");
    fireEvent.click(screen.getByTestId("welcome-next"));
    // the tab closes: nothing saved
    first.unmount();
    expect(mockDb.accountSettings.onboarding.welcome_done).not.toBe(true);
    resetAccountSettingsCache();
    const second = renderProjects();
    expect(await screen.findByTestId("welcome-device-quest")).toBeTruthy();
    fireEvent.click(screen.getByTestId("welcome-next"));
    fireEvent.click(await screen.findByTestId("welcome-next"));
    fireEvent.click(await screen.findByTestId("welcome-later"));
    await waitFor(() => expect(mockDb.accountSettings.onboarding.welcome_done).toBe(true));
    second.unmount();
    resetAccountSettingsCache();
    renderProjects();
    expect(await screen.findByTestId("card-sample")).toBeTruthy();
    expect(screen.queryByTestId("welcome")).toBeNull();
  });
});

describe("the welcome keeps its taps (owner bug 2026-11-05)", () => {
  it("a variant landing late and a list reload under it neither close, remount nor lose the picks", async () => {
    mockDb.projects.clear();
    mockDb.sampleSeeding = true;
    renderProjects();
    const quest = await screen.findByTestId("welcome-device-quest");
    const dialog = screen.getByTestId("welcome");
    fireEvent.click(quest);
    expect(quest.getAttribute("aria-pressed")).toBe("true");
    // the onboarding data lands later and would make it the app Pro welcome
    const c = appStore.get(accountSettingsAtom)!;
    appStore.set(accountSettingsAtom, {
      ...c,
      settings: { ...c.settings!, onboarding: { ...c.settings!.onboarding, variant: "app_pro" } },
    });
    // the list empties for a moment and reloads (sample seeding, a refresh)
    appStore.set(projectListAtom, (l) => ({ ...l, projects: null }));
    await appStore.set(loadProjectsAtom, { client: { listProjects: async () => ({ projects: [] }) } as never });
    await act(async () => {});
    expect(screen.getByTestId("welcome")).toBe(dialog);
    expect(screen.getByTestId("welcome-device-quest").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("welcome-device-avp"));
    fireEvent.click(screen.getByTestId("welcome-next"));
    await waitFor(() => expect(mockDb.accountSettings.headsets).toEqual(["quest", "avp"]));
  });
});

describe("app Pro welcome (owner 2026-11-04)", () => {
  beforeEach(() => {
    (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
    resetProForTests();
    resetPricingCache();
    mockDb.tierPricing = true;
    mockDb.accountSettings.simulate_app_pro = true;
    mockDb.pro = true;
  });
  afterEach(() => {
    delete (globalThis as { __mockDb?: typeof mockDb }).__mockDb;
  });

  it("new account: Pro lines, headsets from the app, then the first project with one Business line", async () => {
    mockDb.projects.clear();
    mockDb.sampleSeeding = true;
    renderProjects();
    const intro = await screen.findByTestId("welcome-app-pro");
    expect(intro.textContent).toContain("Your Pro works here too");
    // the share and the plan's previews arrive with /v1/pricing and /v1/pro
    await waitFor(() => expect(intro.textContent).toContain("Pro prices on every video, 15% off."));
    await waitFor(() => expect(intro.textContent).toContain("Your plan includes 20 free previews a month."));
    expect(intro.textContent).toContain("Nothing new is billed.");
    // prefilled from the app
    expect(screen.getByTestId("welcome-device-avp").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("welcome-business")).toBeNull();
    fireEvent.click(screen.getByTestId("welcome-next"));
    await waitFor(() => expect(mockDb.accountSettings.headsets).toEqual(["avp"]));
    await waitFor(() => expect(mockDb.events.at(-1)?.name).toBe("onboarding_headsets"));
    expect(mockDb.events.at(-1)?.props).toMatchObject({ devices: ["avp"], plan: "pro", variant: "app_pro" });
    // straight to the first project; Business once, muted
    expect(await screen.findByTestId("welcome-sample")).toBeTruthy();
    expect(screen.getAllByTestId("welcome-business")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("welcome-later"));
    await waitFor(() => expect(mockDb.accountSettings.onboarding).toMatchObject({ welcome_done: true, app_pro_welcome_done: true }));
    // no Pro upsells for them
    expect(screen.queryByTestId("plans-banner")).toBeNull();
    expect(screen.queryByTestId("plans-line")).toBeNull();
  });

  it("other_headset from the app preselects nothing and says so", async () => {
    mockDb.projects.clear();
    server.use(
      http.get("*/v1/account/settings", async () => {
        return HttpResponse.json({
          lifelike_intro: true, lifelike_intro_editable: false, locale: null, headsets: null, hints_seen: [], dismissed: {},
          simulate_app_pro: true,
          onboarding: { variant: "app_pro", app_pro_welcome_done: false, headsets_from_app: [], headsets_from_app_source: null, app_viewing_device: "other_headset" },
        });
      }),
    );
    renderProjects();
    await screen.findByTestId("welcome-app-pro");
    expect(screen.getByTestId("welcome-device-avp").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(/You told the app you use a headset\./)).toBeTruthy();
  });

  it("an older web account that gains app Pro gets the Pro step alone, once", async () => {
    mockDb.accountSettings.onboarding = { welcome_done: true };
    renderProjects();
    const intro = await screen.findByTestId("welcome-app-pro");
    expect(intro.textContent).toContain("Your Pro works here too");
    expect(screen.queryByTestId("welcome-device-avp")).toBeNull();
    expect(screen.getAllByTestId("welcome-business")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("welcome-got-it"));
    await waitFor(() => expect(mockDb.accountSettings.onboarding.app_pro_welcome_done).toBe(true));
    expect(mockDb.accountSettings.onboarding.welcome_done).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("welcome")).toBeNull());
  });
});

describe("the welcome's Business line follows the nudge rule (QA 2026-11-05)", () => {
  beforeEach(() => {
    (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
    resetProForTests();
    resetPricingCache();
    mockDb.tierPricing = true;
    mockDb.accountSettings.simulate_app_pro = true;
  });
  afterEach(() => {
    delete (globalThis as { __mockDb?: typeof mockDb }).__mockDb;
  });

  async function lastStep(): Promise<void> {
    mockDb.accountSettings.onboarding = { welcome_done: true };
    render(
      <AuthProvider>
        <BillingProvider>
          <ProjectsScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    await screen.findByTestId("welcome-app-pro");
  }

  it("a Studio account: no Business line", async () => {
    mockDb.billing.plan = {
      plan: "studio",
      name: "Studio",
      status: "active",
      active: true,
      credit_cents: 150000,
      credit_left_cents: 150000,
      cancel_at_period_end: false,
      interval: "year",
      price_cents: 1198800,
    };
    await lastStep();
    // the plan has landed (the Pro card says it's included elsewhere)
    await waitFor(() => expect(screen.queryByTestId("welcome-business")).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("welcome-business")).toBeNull();
  });

  it("no plan: the line shows", async () => {
    mockDb.pro = false;
    await lastStep();
    expect(await screen.findByTestId("welcome-business")).toBeTruthy();
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
