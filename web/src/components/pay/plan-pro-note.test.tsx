/**
 * QA 2026-11-05: choosing Business or Studio while Pro says what happens to
 * that Pro: an App Store Pro or a grant keeps running (the new checkout),
 * and a web Pro moves by plan change, credited for the unused Pro.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PricingScreen } from "@/components/pricing/PricingScreen";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { resetProForTests } from "@/lib/pro/usePro";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { proNoteFor } from "./PlanSheet";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pricing",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetProForTests();
  mockDb.reset();
});
afterAll(() => server.close());

async function chooseBusiness(): Promise<HTMLElement> {
  mockDb.tierPricing = true;
  (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
  render(
    <AuthProvider>
      <BillingProvider>
        <PricingScreen />
      </BillingProvider>
    </AuthProvider>,
  );
  const card = await screen.findByTestId("plan-business");
  fireEvent.click(await within(card).findByTestId("choose-business"));
  await screen.findByTestId("plan-main");
  return screen.getByTestId("plan-sheet");
}

describe("a plan while Pro", () => {
  it("the words per Pro source", () => {
    expect(proNoteFor({ pro: true, known: true, source: "app_store" }, "Business")).toBe(
      "Your App Store Pro keeps running. You can cancel it in your Apple ID settings.",
    );
    expect(proNoteFor({ pro: true, known: true, source: "promotional" }, "Business")).toBe(
      "Your Pro from Spatial Video Studio keeps running alongside Business.",
    );
    expect(proNoteFor({ pro: false, known: true }, "Business")).toBeNull();
    expect(proNoteFor({ pro: true, known: true, source: "stripe" }, "Business")).toBeNull();
  });

  it("an App Store Pro: the sheet says it keeps running; the price doesn't change", async () => {
    mockDb.proStatus = { pro: true, known: true, source: "app_store", via: "pro_subs_1m_v1" };
    const sheet = await chooseBusiness();
    expect((await within(sheet).findByTestId("plan-pro-note")).textContent).toBe(
      "Your App Store Pro keeps running. You can cancel it in your Apple ID settings.",
    );
    expect(screen.getByTestId("plan-main").textContent).toContain("Start Business · $299.00");
  });

  it("a web Pro: Business is a plan change credited for the unused Pro, never a second checkout", async () => {
    mockDb.proStatus = { pro: true, known: true, source: "stripe", plan_id: "pro_monthly" };
    const posts: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "POST") posts.push(new URL(request.url).pathname);
    });
    mockDb.tierPricing = true;
    (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
    render(
      <AuthProvider>
        <BillingProvider>
          <PricingScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    const card = await screen.findByTestId("plan-business");
    const choose = (await within(card).findByTestId("choose-business")) as HTMLButtonElement;
    await waitFor(() => expect(choose.disabled).toBe(false));
    fireEvent.click(choose);
    const sheet = await screen.findByTestId("plan-change-sheet");
    expect(screen.queryByTestId("plan-sheet")).toBeNull();
    const line = await within(sheet).findByTestId("plan-change-line");
    expect(line.textContent).toMatch(/^Today: \$[\d,]+\.\d\d\. Business \$299\.00 − \$[\d.]+ for your unused Pro Monthly\.$/);
    const pay = within(sheet).getByTestId("plan-change-main");
    expect(pay.textContent).toMatch(/^Pay \$[\d,]+\.\d\d and change$/);
    fireEvent.click(pay);
    expect(await screen.findByText("Business is on. $400 of usage is ready.")).toBeTruthy();
    expect(mockDb.planChanges).toEqual(["business"]);
    expect(posts).toContain("/v1/plans/preview-change");
    expect(posts).toContain("/v1/plans/change");
    // no new plan checkout
    expect(posts).not.toContain("/v1/billing/plan");
    server.events.removeAllListeners();
  });

  it("no Pro: no line", async () => {
    const sheet = await chooseBusiness();
    expect(within(sheet).queryByTestId("plan-pro-note")).toBeNull();
  });
});
