/**
 * "Get another format" for a finished run (ADR 0137): free, made from the
 * run's files; polls until done, then the file shows with its download.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { http, HttpResponse } from "msw";

import type { Conversion } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { aboutMinutes, AnotherFormat, FORMAT_POLL_MS, FORMAT_POLL_SLOW_MS, LONG_WAIT_COPY, TOO_WIDE_COPY } from "./AnotherFormat";
import { RunFiles } from "./RunFiles";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const PROJECT_ID = (projectFixture as { project_id: string }).project_id;

function run(over: Partial<Conversion> = {}): Conversion {
  const c: Conversion = {
    conversion_id: "conv_formats_1",
    state: "succeeded",
    kind: "video",
    method: "lifelike",
    project_id: PROJECT_ID,
    step: "production",
    params: { preset: "1080p", formats: ["mvhevc"] },
    quote: { amount_cents: 500, currency: "usd" },
    progress: 1,
    outputs: ["mvhevc"],
    created_at: "2026-11-01T09:00:00Z",
    updated_at: "2026-11-01T09:10:00Z",
    ...over,
  } as Conversion;
  mockDb.conversions.set(c.conversion_id, c);
  return c;
}

const renderRun = (c: Conversion) =>
  render(
    <AuthProvider>
      <BillingProvider>
        <RunFiles conversion={c} />
      </BillingProvider>
    </AuthProvider>,
  );

/** Radix menus open on Enter in jsdom. */
async function openMenu() {
  fireEvent.keyDown(await screen.findByTestId("another-format-open"), { key: "Enter" });
}

describe("Get another format (ADR 0137)", () => {
  it("lists the formats it can make, free, with their captions and the half-size hint", async () => {
    renderRun(run());
    const box = await screen.findByTestId("another-format");
    expect(within(box).getByText("Free")).toBeTruthy();
    expect(box.textContent).not.toMatch(/\$|render|convert/i);
    await openMenu();
    const sbs = await screen.findByTestId("another-format-sbs");
    expect(sbs.textContent).toContain("Side by side");
    expect(sbs.textContent).toContain("For Meta Quest, Galaxy XR, Pico, Steam Frame and XR glasses");
    expect((await screen.findByTestId("another-format-half_sbs")).textContent).toContain(
      "About half the file size of full side-by-side. Handy when a file is too big to copy or stream.",
    );
    expect(screen.queryByTestId("another-format-mvhevc")).toBeNull(); // the run has it
  });

  it("starting one says Making it…, polls, then the file appears with its download", async () => {
    mockDb.formatJobPolls = 2;
    renderRun(run());
    await openMenu();
    fireEvent.click(await screen.findByTestId("another-format-sbs"));
    expect((await screen.findByTestId("another-format-making-sbs")).textContent).toContain("Making it…");
    await waitFor(() => expect(screen.getByTestId("file-group-sbs")).toBeTruthy(), { timeout: FORMAT_POLL_MS * 3 });
    expect(within(screen.getByTestId("file-group-sbs")).getByText("Download")).toBeTruthy();
    expect(screen.queryByTestId("another-format-making-sbs")).toBeNull();
  }, 15_000);

  it("a failed one says try again, and the retry works", async () => {
    mockDb.formatJobsFail = true;
    renderRun(run());
    await openMenu();
    fireEvent.click(await screen.findByTestId("another-format-half_sbs"));
    const failed = await screen.findByTestId("another-format-failed-half_sbs", {}, { timeout: FORMAT_POLL_MS * 2 });
    expect(failed.textContent).toContain("That didn't work. Try again.");
    mockDb.formatJobsFail = false;
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("file-group-half_sbs")).toBeTruthy(), { timeout: FORMAT_POLL_MS * 3 });
  }, 15_000);

  it("the service being down shows the failed state with a retry", async () => {
    mockDb.formatServiceDown = true;
    renderRun(run());
    await openMenu();
    fireEvent.click(await screen.findByTestId("another-format-sbs"));
    const failed = await screen.findByTestId("another-format-failed-sbs");
    expect(within(failed).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("6K/8K: full side by side is left out; too_wide says to pick half size or spatial", async () => {
    // a gateway that still lists full side by side at 8K, and refuses it
    server.use(
      http.get("*/v1/runs/:id/formats", () =>
        HttpResponse.json({ available: ["sbs", "half_sbs"], have: ["mvhevc"], pending: [], price_cents: 0, jobs: {} }),
      ),
      http.post("*/v1/runs/:id/formats", () =>
        HttpResponse.json(
          { success: false, error: "format_unavailable", message: "too wide", details: { reason: "too_wide" } },
          { status: 409 },
        ),
      ),
    );
    renderRun(run({ params: { preset: "8k", formats: ["mvhevc"] } }));
    await openMenu();
    expect(await screen.findByTestId("another-format-half_sbs")).toBeTruthy();
    expect(screen.queryByTestId("another-format-sbs")).toBeNull();
    fireEvent.click(screen.getByTestId("another-format-half_sbs"));
    expect(await screen.findByText(TOO_WIDE_COPY)).toBeTruthy();
    expect(TOO_WIDE_COPY).toBe(
      "Full side by side isn't made at 6K and 8K. Pick Side by side (half size) or Spatial video.",
    );
    // never a reason for the whole control
    expect(screen.queryByTestId("another-format-unavailable")).toBeNull();
  });

  it("half_only: says why, in plain words", async () => {
    renderRun(run({ outputs: ["half_sbs"], params: { preset: "8k", formats: ["half_sbs"] } }));
    expect((await screen.findByTestId("another-format-unavailable")).textContent).toBe(
      "This run only has the half-size file. Make a new conversion for other formats.",
    );
  });

  it("files_erased: says why", async () => {
    mockDb.projects.get(PROJECT_ID)!.files_deleted_at = "2026-10-01T00:00:00Z";
    render(
      <AuthProvider>
        <AnotherFormat conversion={run()} onNewFile={() => {}} />
      </AuthProvider>,
    );
    expect((await screen.findByTestId("another-format-unavailable")).textContent).toBe(
      "These files were erased after 90 days without use.",
    );
  });

  it("not on previews or when every format is there", async () => {
    renderRun(run({ outputs: ["mvhevc", "sbs", "half_sbs"] }));
    await screen.findByTestId("file-group-sbs");
    await act(async () => {});
    expect(screen.queryByTestId("another-format")).toBeNull();
    cleanup();
    renderRun(run({ conversion_id: "conv_prev", step: "lifelike_preview" }));
    await screen.findByTestId("run-files");
    expect(screen.queryByTestId("another-format")).toBeNull();
  });

  it("Spatial video: an estimate and that it can take a while", async () => {
    mockDb.formatJobPolls = 100; // still being made
    renderRun(run({ outputs: ["sbs"], params: { preset: "1080p", formats: ["sbs"] } }));
    await openMenu();
    fireEvent.click(await screen.findByTestId("another-format-mvhevc"));
    const making = await screen.findByTestId("another-format-making-mvhevc");
    await waitFor(() => expect(making.textContent).toContain("About 4 minutes"));
    expect(making.textContent).toContain("Making it…");
    expect(making.textContent).toContain(LONG_WAIT_COPY);
    expect(LONG_WAIT_COPY).toBe("This can take a while. You can leave this page; the file appears here when it's ready.");
  });

  it("a short one shows its estimate without the long-wait line", async () => {
    mockDb.formatJobPolls = 100;
    renderRun(run());
    await openMenu();
    fireEvent.click(await screen.findByTestId("another-format-half_sbs"));
    const making = await screen.findByTestId("another-format-making-half_sbs");
    await waitFor(() => expect(making.textContent).toContain("About 1 minute"));
    expect(making.textContent).not.toContain(LONG_WAIT_COPY);
    expect(aboutMinutes(150)).toBe("About 3 minutes");
  });

  it("keeps asking every 3 s, then every 15 s after the first minute", async () => {
    mockDb.formatJobPolls = 100;
    const timers = vi.spyOn(globalThis, "setTimeout");
    renderRun(run());
    await openMenu();
    fireEvent.click(await screen.findByTestId("another-format-sbs"));
    await screen.findByTestId("another-format-making-sbs");
    await waitFor(() => expect(timers.mock.calls.some((c) => c[1] === FORMAT_POLL_MS)).toBe(true));
    // a minute later
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    await waitFor(() => expect(timers.mock.calls.some((c) => c[1] === FORMAT_POLL_SLOW_MS)).toBe(true), {
      timeout: FORMAT_POLL_MS * 3,
    });
    vi.restoreAllMocks();
  }, 15_000);

  it("a split run gets the new format per part", async () => {
    renderRun(
      run({
        parts: [
          { index: 1, start_s: 0, duration_s: 900 },
          { index: 2, start_s: 900, duration_s: 300 },
        ],
        outputs: ["mvhevc_part01", "mvhevc_part02"],
      }),
    );
    await openMenu();
    fireEvent.click(await screen.findByTestId("another-format-sbs"));
    await waitFor(() => expect(screen.getByTestId("file-group-sbs")).toBeTruthy(), { timeout: FORMAT_POLL_MS * 3 });
    const rows = within(screen.getByTestId("file-group-sbs")).getAllByText(/^Part \d$/);
    expect(rows.map((r) => r.textContent)).toEqual(["Part 1", "Part 2"]);
  }, 15_000);

  it("an older gateway's split_run still says why", async () => {
    server.use(
      http.get("*/v1/runs/:id/formats", () =>
        HttpResponse.json({ available: [], have: ["mvhevc"], pending: [], unavailable_reason: "split_run", price_cents: 0, jobs: {} }),
      ),
    );
    renderRun(run());
    expect((await screen.findByTestId("another-format-unavailable")).textContent).toMatch(/^This run is in parts/);
  });
});
