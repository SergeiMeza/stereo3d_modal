/**
 * Owner 2026-11-05: the quote and the run send exactly the ticked "Files
 * you'll get", for every device pick, also after Master bitrate, Express
 * and Remove black bars change; the price box and the pay sheet say which
 * files the run makes.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversion, Format, Project } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { FORMAT_NAMES, formatsText } from "@/lib/glossary";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { ProjectStateProvider } from "@/lib/state/stores";

import { LifelikeDeliverPanel } from "./LifelikeDeliverPanel";
import { make3dChoicesAtom } from "./make3dAtoms";
import { DEVICES, formatsForDevices } from "./makeControls";
import { lifelikeFormatsFor } from "./methods";
import { payLine } from "./useStepCheckout";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 30 }));

const PID = (projectFixture as { project_id: string }).project_id;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  mockDb.tierPricing = true;
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

/** Bodies POSTed to a path suffix. */
function capture(suffix: string): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(suffix)) {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
    }
  });
  return bodies;
}

function ticked(): Format[] {
  const group = screen.getByRole("group", { name: "Files you'll get" });
  const names = Object.entries(FORMAT_NAMES) as [Format, string][];
  return names
    .filter(([, label]) => {
      const box = within(group).queryByRole("checkbox", { name: label }) as HTMLInputElement | null;
      return box?.checked === true;
    })
    .map(([f]) => f);
}

const sorted = (x: unknown) => [...((x as string[]) ?? [])].sort();

function pickDevices(labels: string[]): void {
  const group = screen.getByRole("group", { name: "Where will you watch it?" });
  for (const box of within(group).getAllByRole("checkbox") as HTMLInputElement[]) {
    const name = box.getAttribute("aria-label") ?? box.closest("label")?.textContent ?? "";
    const want = labels.some((l) => name.includes(l));
    if (box.checked !== want) fireEvent.click(box);
  }
}

/** The main quote's body: the run's own quality (not a quality card's). */
function mainQuotes(bodies: Record<string, unknown>[], preset: string) {
  return bodies.filter((b) => b.step === "production" && b.preset === preset && b.method === undefined);
}

describe("the files a run makes are the ticked ones", () => {
  it("every device pick preselects the files it needs, in the offered order", () => {
    const offered = lifelikeFormatsFor({ preset: "4k" });
    const ids = DEVICES.map((d) => d.id);
    for (let mask = 1; mask < 1 << ids.length; mask++) {
      const pick = ids.filter((_, i) => mask & (1 << i));
      const files = formatsForDevices(pick, offered, "4k");
      expect(files.every((f) => offered.includes(f))).toBe(true);
      expect(files.length).toBeGreaterThan(0);
    }
  });

  it.each([
    [["Apple Vision Pro"]],
    [["Meta Quest"]],
    [["Apple Vision Pro", "Meta Quest"]],
    [["Apple Vision Pro", "Pico"]],
    [["3D TV or projector"]],
    [["Not sure"]],
  ])("for %j, after Master file quality, Express and Remove black bars, the quote and the run send the ticks", async (labels) => {
    const quotes = capture("/quotes");
    const runs = capture("/conversions");
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={project({ has_bars: true, remove_bars: true })} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    await screen.findByTestId("file-quality");
    pickDevices(labels);
    // the person also ticks Side by side by hand where it's offered
    const files = screen.getByRole("group", { name: "Files you'll get" });
    const sbs = within(files).queryByRole("checkbox", { name: FORMAT_NAMES.sbs }) as HTMLInputElement | null;
    if (sbs && !sbs.checked) fireEvent.click(sbs);
    fireEvent.click(within(screen.getByTestId("file-quality-master")).getByRole("radio"));
    fireEvent.click(within(screen.getByTestId("addon-express")).getByRole("checkbox"));
    const bars = within(screen.getByTestId("bars-toggle")).getByRole("checkbox");
    fireEvent.click(bars);
    await waitFor(() => expect((bars as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(bars);
    await waitFor(() => expect((bars as HTMLInputElement).disabled).toBe(false));

    const want = ticked();
    expect(want.length).toBeGreaterThan(0);
    const main = screen.getByTestId("checkout-main") as HTMLButtonElement;
    await waitFor(() => expect(main.disabled).toBe(false), { timeout: 3000 });
    const preset = (quotes.at(-1)?.preset as string) ?? "4k";
    const last = mainQuotes(quotes, preset).at(-1)!;
    expect(sorted(last.formats)).toEqual(sorted(want));
    // the price box names the files the quote is for
    expect(screen.getByTestId("run-files").textContent).toBe(
      `You'll get: ${formatsText(last.formats as string[])}`,
    );
    fireEvent.click(main);
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(sorted(runs[0].formats)).toEqual(sorted(want));
  });
});

describe("the pay sheet", () => {
  function waiting(formats: Format[]): Conversion {
    const c: Conversion = {
      conversion_id: "cwaitfmt0001",
      state: "created",
      kind: "video",
      project_id: PID,
      step: "production",
      method: "lifelike",
      params: { preset: "4k", formats },
      quote: { amount_cents: 1360, currency: "usd" },
      progress: 0,
      billing: { status: "requires_payment", reason: "no_method" },
      created_at: "2026-11-05T17:11:58Z",
      updated_at: "2026-11-05T17:11:58Z",
    } as Conversion;
    mockDb.conversions.set(c.conversion_id, c);
    return c;
  }

  it("the pay sheet's line names its files", () => {
    expect(payLine(waiting(["mvhevc"]))).toMatch(/· Vision Pro spatial video$/);
    expect(payLine(waiting(["mvhevc", "sbs"]))).toMatch(/· Vision Pro spatial video \+ Side by side$/);
  });
});

describe("Make 3D picks (owner 2026-11-05)", () => {
  /** A project page as the app mounts it: its own store. */
  function page(p: Project) {
    return render(
      <AuthProvider>
        <ProjectStateProvider key={p.project_id} projectId={p.project_id}>
          <LifelikeDeliverPanel project={p} onProjectChanged={() => {}} />
        </ProjectStateProvider>
      </AuthProvider>,
    );
  }

  function spatialOnly(): void {
    const files = screen.getByRole("group", { name: "Files you'll get" });
    for (const box of within(files).getAllByRole("checkbox") as HTMLInputElement[]) {
      const spatial = box.getAttribute("aria-label") === FORMAT_NAMES.mvhevc;
      if (box.checked !== spatial) fireEvent.click(box);
    }
  }

  /** A reload: the page's store and the in-memory atoms are gone. */
  function reload(view: ReturnType<typeof page>, id: string): void {
    view.unmount();
    make3dChoicesAtom.remove(id);
  }

  it("survive a reload: spatial only stays spatial only", async () => {
    const p = project();
    const first = page(p);
    await screen.findByTestId("file-quality");
    pickDevices(["Samsung Galaxy XR", "XR glasses"]);
    spatialOnly();
    expect(ticked()).toEqual(["mvhevc"]);
    reload(first, p.project_id);
    page(p);
    await screen.findByTestId("file-quality");
    expect(ticked()).toEqual(["mvhevc"]);
  });

  it("don't carry over to another project", async () => {
    const p = project();
    const first = page(p);
    await screen.findByTestId("file-quality");
    pickDevices(["Apple Vision Pro"]);
    spatialOnly();
    first.unmount();
    const other: Project = { ...p, project_id: "zz9other00001" };
    mockDb.projects.set(other.project_id, structuredClone(other));
    page(other);
    await screen.findByTestId("file-quality");
    // the other project starts from its own preselection
    expect(ticked()).toEqual(expect.arrayContaining(["mvhevc"]));
    expect(ticked().length).toBeGreaterThan(1);
  });

  it("a headset change never overwrites a file pick", async () => {
    page(project());
    await screen.findByTestId("file-quality");
    spatialOnly();
    pickDevices(["Samsung Galaxy XR", "XR glasses"]);
    expect(ticked()).toEqual(["mvhevc"]);
    pickDevices(["Meta Quest"]);
    expect(ticked()).toEqual(["mvhevc"]);
  });

  it("the devices preselect the files while none were ticked by hand", async () => {
    page(project());
    await screen.findByTestId("file-quality");
    pickDevices(["Apple Vision Pro"]);
    expect(ticked()).toEqual(["mvhevc"]);
    pickDevices(["Samsung Galaxy XR"]);
    expect(ticked()).toEqual(["sbs"]);
  });
});
