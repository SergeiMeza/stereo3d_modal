/**
 * Make 3D's price (owner on staging, 2026-11-05): an older quote landing
 * last never shows for newer selections ("Updating…" while it comes), a
 * run in progress still gets its price, a quote that never answers turns
 * into Retry, and the quality sizes follow Remove black bars.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversion, Project } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { qualityChoices } from "@/lib/glossary";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { LifelikeDeliverPanel, withoutBars } from "./LifelikeDeliverPanel";
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
    const row = await screen.findByTestId("file-quality-master");
    await waitFor(() => expect(buttonPrice()).not.toBeNull());
    server.use(
      http.post(QUOTES, async () => {
        await delay(300);
        return undefined;
      }),
    );
    fireEvent.click(within(row).getByRole("radio"));
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
    // the run stays in progress while we look (no status stream moves it;
    // its slow poll is 15 s away)
    mockDb.eventsDown = true;
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

describe("quality sizes and black bars", () => {
  // the fixture: 3840×2160 with the picture at 3840×1606 (1606/2 = 803,
  // rounded to an even 804 as the bars setting says)
  it("says the size without the bars while they're removed", () => {
    const p = project({ has_bars: true, remove_bars: true });
    const sizes = withoutBars(qualityChoices(p), p).map((q) => q.hint);
    expect(sizes).toContain("1920×804 per eye");
    expect(sizes).toContain("3840×1606 per eye");
    expect(sizes).not.toContain("1920×1080 per eye");
  });

  it("keeps the full size when the bars stay, or there are none", () => {
    const kept = project({ has_bars: true, remove_bars: false });
    expect(withoutBars(qualityChoices(kept), kept).map((q) => q.hint)).toContain("1920×1080 per eye");
    const none = project({ has_bars: false });
    expect(withoutBars(qualityChoices(none), none).map((q) => q.hint)).toContain("1920×1080 per eye");
  });

  it("the quality cards show it", async () => {
    panel(project({ has_bars: true, remove_bars: true }));
    const tile = await screen.findByTestId("quality-1080p");
    expect(tile.textContent).toContain("1920×804 per eye");
  });
});
