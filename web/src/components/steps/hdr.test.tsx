/**
 * HDR output (owner 2026-11-05): automatic and free for everyone, no
 * toggle. With the gateway's hdr_output, Overview says "HDR video" and
 * Make 3D shows one info line; without it nothing says HDR.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { FORMAT_NAMES, videoFacts } from "@/lib/glossary";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { hdrLine, LifelikeDeliverPanel } from "./LifelikeDeliverPanel";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 30 }));

const PID = (projectFixture as { project_id: string }).project_id;
const FREE = "Your 3D will be in HDR, so bright highlights and rich colour are kept. Free.";
const SBS = "Side-by-side files are made in standard colour for headsets that don't show HDR.";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.events.removeAllListeners();
  act(() => clearStepQuotes());
  server.resetHandlers();
  mockDb.reset();
  resetPricingCache();
});
afterAll(() => server.close());

function project(hdr: Record<string, unknown>) {
  const p = mockDb.projects.get(PID)!;
  p.method = "lifelike";
  return structuredClone({ ...p, conversions: [], ...hdr });
}

function captureQuotes(): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/quotes")) {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
    }
  });
  return bodies;
}

function panel(p: ReturnType<typeof project>) {
  return render(
    <AuthProvider>
      <LifelikeDeliverPanel project={p} onProjectChanged={() => {}} />
    </AuthProvider>,
  );
}

describe("HDR output on Make 3D", () => {
  beforeEach(() => {
    mockDb.tierPricing = true;
    resetPricingCache();
  });

  it.each([
    ["absent", {}],
    ["false", { hdr_output: false, hdr_available: false }],
    ["available but not this video", { hdr_output: false, hdr_available: true }],
  ])("says nothing about HDR when hdr_output is %s", async (_, hdr) => {
    const quotes = captureQuotes();
    panel(project(hdr));
    await waitFor(() => expect(quotes.some((q) => q.step === "production")).toBe(true));
    expect(screen.queryByTestId("make-hdr")).toBeNull();
    expect(document.body.textContent).not.toMatch(/HDR/);
  });

  it("an info line, no control, and no hdr field in the request", async () => {
    const quotes = captureQuotes();
    panel(project({ hdr_output: true, hdr_available: true }));
    const line = await screen.findByTestId("make-hdr");
    expect(line.textContent?.startsWith(FREE)).toBe(true);
    expect(within(line).queryByRole("checkbox")).toBeNull();
    expect(screen.queryByTestId("addon-hdr")).toBeNull();
    await waitFor(() => expect(quotes.some((q) => q.step === "production")).toBe(true));
    expect(quotes.some((q) => "hdr" in q)).toBe(false);
  });

  it("names the standard-colour side-by-side files only when they're picked", async () => {
    panel(project({ hdr_output: true }));
    const line = await screen.findByTestId("make-hdr");
    const files = screen.getByRole("group", { name: "Files you'll get" });
    const box = (f: "sbs" | "half_sbs") =>
      within(files).queryByRole("checkbox", { name: FORMAT_NAMES[f] }) as HTMLInputElement | null;
    for (const f of ["sbs", "half_sbs"] as const) {
      const b = box(f);
      if (b?.checked) fireEvent.click(b);
    }
    await waitFor(() => expect(line.textContent).toBe(FREE));
    fireEvent.click(box("sbs") ?? box("half_sbs")!);
    await waitFor(() => expect(line.textContent).toBe(`${FREE} ${SBS}`));
    expect(hdrLine(["mvhevc"])).toBe(FREE);
    expect(hdrLine(["mvhevc", "sbs"])).toBe(`${FREE} ${SBS}`);
    expect(hdrLine(["half_sbs"])).toBe(`${FREE} ${SBS}`);
    expect(hdrLine(["tb"])).toBe(FREE);
  });
});

describe("HDR output on Overview", () => {
  const probe = { width: 3840, height: 2160, fps: 30, duration_s: 10 } as never;

  it("says HDR video only with hdr_output", () => {
    expect(videoFacts({ probe })).not.toContain("HDR");
    expect(videoFacts({ probe, hdr_output: false })).not.toContain("HDR");
    expect(videoFacts({ probe, hdr_output: true })).toMatch(/· HDR video$/);
  });
});
