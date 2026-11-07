/**
 * Deferred payments are off on staging and prod (gateway
 * deferred_payments_enabled false): every card-paid run pays before it
 * starts, so Make 3D never says "Charged after it's done" (owner
 * 2026-11-07). The dev mock runs that way; unit tests elsewhere turn
 * deferred on to cover the charged-after path.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { LifelikeDeliverPanel } from "./LifelikeDeliverPanel";
import { CHARGE_AFTER_COPY, CHARGE_BEFORE_COPY } from "./QuoteView";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 40 }));

const PID = (projectFixture as { project_id: string }).project_id;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  act(() => clearStepQuotes());
  resetPricingCache();
  mockDb.reset();
});
afterAll(() => server.close());

describe("deferred payments off (staging and prod)", () => {
  it("a cheap card-paid run reads pay-before, quoted as pay now", async () => {
    mockDb.deferredPayments = false;
    const flows: string[] = [];
    server.events.on("response:mocked", async ({ request, response }) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/quotes")) {
        const body = (await response.clone().json()) as { payment_flow?: string; charge_timing?: string };
        flows.push(`${body.payment_flow}/${body.charge_timing}`);
      }
    });
    const p = mockDb.projects.get(PID)!;
    p.method = "lifelike";
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={structuredClone({ ...p, conversions: [] }) as Project} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    await screen.findByTestId("quote-breakdown", {}, { timeout: 4000 });
    await waitFor(() => expect(flows.length).toBeGreaterThan(0));
    expect(flows.every((f) => f === "paynow/before")).toBe(true);
    expect(document.body.textContent).toContain(CHARGE_BEFORE_COPY);
    expect(document.body.textContent).not.toContain(CHARGE_AFTER_COPY);
  });
});
