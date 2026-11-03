/**
 * BL-25: the Stereo3D intro switch for Business and Studio (gateway 00087).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { IntroSwitch, PlanCard } from "./PlanCard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/account/billing",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function withPlan() {
  mockDb.billing.plan = {
    plan: "business", name: "Business", status: "active", active: true, monthly_cents: 29900,
    credit_cents: 40000, credit_left_cents: 40000, cancel_at_period_end: false,
  };
}

function renderSwitch(node = <IntroSwitch />) {
  render(
    <AuthProvider>
      <BillingProvider>{node}</BillingProvider>
    </AuthProvider>,
  );
}

const sw = () => screen.findByRole("switch", { name: "Add the Stereo3D intro to my videos" });

describe("Stereo3D intro switch (BL-25)", () => {
  it("in the plan card, on by default, with its one line; turning it off saves", async () => {
    withPlan();
    renderSwitch(<PlanCard />);
    const s = await sw();
    expect(s.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("A short Stereo3D Studio title plays before your videos.")).toBeTruthy();
    fireEvent.click(s);
    // moves at once
    expect(s.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(mockDb.accountSettings.lifelike_intro).toBe(false));
    // no length, no billing, nothing on how it's made
    expect(screen.getByTestId("intro-switch").textContent).not.toMatch(/second|\$|charge|price|bill|render|overlay|encode/i);
  });

  it("hidden when the gateway says it isn't editable", async () => {
    renderSwitch();
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.queryByTestId("intro-switch")).toBeNull();
  });

  it("goes back when the save fails", async () => {
    withPlan();
    mockDb.nextSettingsFails = true;
    renderSwitch();
    const s = await sw();
    fireEvent.click(s);
    expect(s.getAttribute("aria-checked")).toBe("false");
    expect(await screen.findByText("Couldn't save that. Try again.")).toBeTruthy();
    expect((await sw()).getAttribute("aria-checked")).toBe("true");
    expect(mockDb.accountSettings.lifelike_intro).toBe(true);
  });

  it("plan_required hides the switch and reads the settings again", async () => {
    withPlan();
    renderSwitch();
    const s = await sw();
    mockDb.billing.plan = null; // the plan ended meanwhile
    fireEvent.click(s);
    await waitFor(() => expect(screen.queryByTestId("intro-switch")).toBeNull());
    expect(mockDb.accountSettings.lifelike_intro).toBe(true);
  });
});
