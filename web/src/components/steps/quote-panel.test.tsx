/**
 * Make 3D's price (owner on staging, 2026-11-05): an older quote landing
 * last never shows for newer selections ("Updating…" while it comes), a
 * run in progress still gets its price, a quote that never answers turns
 * into Retry.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversion, Project } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { LifelikeDeliverPanel } from "./LifelikeDeliverPanel";
import { QUOTE_TIMED_OUT, QUOTE_TIMEOUT_MS } from "./useStepCheckout";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 30 }));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const PID = (projectFixture as { project_id: string }).project_id;
const QUOTES = `${GATEWAY}/v1/projects/:id/quotes`;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  mockDb.tierPricing = true;
  resetPricingCache();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  server.events.removeAllListeners();
  act(() => clearStepQuotes());
  server.resetHandlers();
  mockDb.reset();
  resetPricingCache();
});
afterAll(() => server.close());

function project(over: Partial<Project> = {}): Project {
  const p = mockDb.projects.get(PID)!;
  p.method = "lifelike";
  Object.assign(p, over);
  return structuredClone({ ...p, conversions: [], ...over });
}

function panel(p: Project) {
  return render(
    <AuthProvider>
      <LifelikeDeliverPanel project={p} onProjectChanged={() => {}} />
    </AuthProvider>,
  );
}

/** The main button's price ("$23.12"), or null without one. */
function buttonPrice(): string | null {
  return screen.getByTestId("checkout-main").textContent?.match(/\$[\d,]+\.\d\d/)?.[0] ?? null;
}

/** The price the mock gives a request, from a direct quote. */
async function priceOf(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${GATEWAY}/v1/projects/${PID}/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const q = (await res.json()) as { quote: { amount_cents: number } };
  return `$${(q.quote.amount_cents / 100).toFixed(2)}`;
}

describe("only the latest quote counts", () => {
  it("an older answer landing last never shows for newer selections", async () => {
    const bodies: Record<string, unknown>[] = [];
    // the main quote without Express answers slowly, with Express fast:
    // the old answer lands after the new one
    server.use(
      http.post(QUOTES, async ({ request }) => {
        const body = (await request.clone().json()) as Record<string, unknown>;
        if (body.step === "production" && Array.isArray(body.formats)) bodies.push(body);
        if (body.express !== true) await delay(400);
        return undefined; // on to the mock gateway
      }),
    );
    panel(project());
    const row = await screen.findByTestId("addon-express");
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    // tick Express while the first quote is still out
    fireEvent.click(within(row).getByRole("checkbox"));
    expect(screen.getByTestId("checkout-main").hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(buttonPrice()).not.toBeNull(), { timeout: 3000 });
    const withExpress = buttonPrice();
    // the slow answer (without Express) has landed by now; it didn't win
    await act(async () => {
      await delay(600);
    });
    expect(buttonPrice()).toBe(withExpress);
    const last = bodies.filter((b) => b.express === true).at(-1)!;
    expect(withExpress).toBe(await priceOf(last));
  });

  it("says Updating… while a change is priced, with no price on the button", async () => {
    panel(project());
    const row = await screen.findByTestId("addon-master");
    await waitFor(() => expect(buttonPrice()).not.toBeNull());
    server.use(
      http.post(QUOTES, async () => {
        await delay(300);
        return undefined;
      }),
    );
    fireEvent.click(within(row).getByRole("checkbox"));
    expect(screen.getByTestId("quote-pending").textContent).toBe("Updating…");
    expect(buttonPrice()).toBeNull();
    await waitFor(() => expect(buttonPrice()).not.toBeNull(), { timeout: 3000 });
    expect(screen.queryByTestId("quote-pending")).toBeNull();
  });
});

describe("a run in progress", () => {
  function runningRun(): Conversion {
    const c: Conversion = {
      conversion_id: "crun00000001",
      state: "processing",
      kind: "video",
      project_id: PID,
      step: "production",
      method: "lifelike",
      params: { preset: "4k", formats: ["mvhevc"] },
      quote: { amount_cents: 2312, currency: "usd" },
      progress: 0.2,
      billing: { status: "charged" },
      created_at: "2026-11-05T17:13:00Z",
      updated_at: "2026-11-05T17:13:58Z",
    } as Conversion;
    mockDb.conversions.set(c.conversion_id, c);
    return c;
  }

  it("still shows the price, says a run is in progress, and keeps Make 3D off", async () => {
    const run = runningRun();
    // the run stays in progress while we look
    server.use(http.get(`${GATEWAY}/v1/conversions/:id`, () => HttpResponse.json(run)));
    const p = project();
    panel({ ...p, conversions: [run] });
    await waitFor(() => expect(buttonPrice()).not.toBeNull(), { timeout: 3000 });
    expect(screen.queryByTestId("quote-pending")).toBeNull();
    expect(screen.getByTestId("run-in-progress").textContent).toBe(
      "A run is in progress. You can start another when it finishes.",
    );
    expect(screen.getByTestId("checkout-main").hasAttribute("disabled")).toBe(true);
  });
});

describe("a quote that never answers", () => {
  it("turns into an error with Retry after 10 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let hang = true;
    server.use(
      http.post(QUOTES, async () => {
        if (hang) await delay("infinite");
        return undefined;
      }),
    );
    panel(project());
    await screen.findByTestId("quote-pending");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUOTE_TIMEOUT_MS + 500);
    });
    expect((await screen.findByTestId("quote-error")).textContent).toBe(QUOTE_TIMED_OUT);
    hang = false;
    fireEvent.click(screen.getByTestId("quote-retry"));
    await waitFor(() => expect(buttonPrice()).not.toBeNull(), { timeout: 3000 });
    expect(screen.queryByTestId("quote-error")).toBeNull();
  });
});
