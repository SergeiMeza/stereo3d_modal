/**
 * QA 2026-11-05 batch 2 (a free preview took 7 s to start and nothing
 * moved): the button is busy and disabled from the click to the answer, a
 * double click creates one run, and once it's created the run shows under
 * Past previews and the free previews left are priced again. The
 * Preview tab's sizes follow Remove black bars.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { LifelikePreviewPanel } from "./LifelikePreviewPanel";
import { STARTING } from "./useStepCheckout";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 30 }));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const PID = (projectFixture as { project_id: string }).project_id;

beforeAll(() => {
  HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause() {};
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  mockDb.tierPricing = true;
  mockDb.pro = true; // a monthly allowance of free previews
  resetPricingCache();
});
afterEach(() => {
  cleanup();
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

function creates(): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/conversions")) {
      bodies.push({ ...((await request.clone().json()) as object), key: request.headers.get("Idempotency-Key") });
    }
  });
  return bodies;
}

describe("starting a free preview", () => {
  it("is busy until the answer, starts one run for a double click, then shows it and the previews left", async () => {
    const posted = creates();
    // CI 2026-11-07: the run used to finish on the 30 ms polls before the
    // free previews were priced again under load, and the finished view
    // has no price line. It waits for a GPU for the whole test instead.
    mockDb.gpuWaitPolls = Number.MAX_SAFE_INTEGER;
    // a cold start: the create answers when the test says so
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    server.use(
      http.post(`${GATEWAY}/v1/projects/:id/conversions`, async () => {
        await answered;
        return undefined;
      }),
    );
    const onProjectChanged = vi.fn();
    render(
      <AuthProvider>
        <LifelikePreviewPanel project={project()} onProjectChanged={onProjectChanged} />
      </AuthProvider>,
    );
    const main = (await screen.findByTestId("checkout-main")) as HTMLButtonElement;
    await waitFor(() => expect(main.disabled).toBe(false), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId("free-previews").textContent).toMatch(/^20 of 20 free previews left/));
    expect(main.textContent).toContain("Free");

    fireEvent.click(main);
    fireEvent.click(main);
    expect(main.textContent).toBe(STARTING);
    expect(main.disabled).toBe(true);
    expect(main.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(main);

    // one run, with its own key, and still busy while the answer is out
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].key).toBeTruthy();
    expect(main.textContent).toBe(STARTING);
    expect(main.disabled).toBe(true);
    answer();

    // created: the run shows at once, the project is read again, and the
    // free previews left are priced again
    expect(await screen.findByRole("region", { name: "Past previews" })).toBeTruthy();
    expect(onProjectChanged).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("free-previews").textContent).toMatch(/^19 of 20 free previews left/), {
      timeout: 3000,
    });
    // the clicks while it was busy never became a second run
    expect(posted).toHaveLength(1);
  });

  it("a failed start says why and gives the button back", async () => {
    server.use(
      http.post(`${GATEWAY}/v1/projects/:id/conversions`, async () => {
        const { HttpResponse } = await import("msw");
        return HttpResponse.json({ error: { code: "internal", message: "Something went wrong. Try again." } }, { status: 500 });
      }),
    );
    render(
      <AuthProvider>
        <LifelikePreviewPanel project={project()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const main = (await screen.findByTestId("checkout-main")) as HTMLButtonElement;
    await waitFor(() => expect(main.disabled).toBe(false), { timeout: 3000 });
    fireEvent.click(main);
    expect(await screen.findByText(/Something went wrong|request failed/)).toBeTruthy();
    await waitFor(() => expect(main.disabled).toBe(false));
    expect(main.textContent).not.toBe(STARTING);
  });
});

describe("the Preview tab and black bars", () => {
  it("names the size without the bars while they're removed", async () => {
    // the fixture: 3840×2160 with the picture at 3840×1606
    render(
      <AuthProvider>
        <LifelikePreviewPanel project={project({ has_bars: true, remove_bars: true })} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const line = await screen.findByTestId("preview-moment");
    expect(line.textContent).toContain("3840×1606 per eye");
    expect(line.textContent).not.toContain("3840×2160");
  });
});
