/**
 * The 3D depth choice and Smoother motion (owner 2026-11-10), Lifelike runs
 * and previews only. Depth: Comfortable · Standard · Strong, Standard by
 * default, no price change, shared by the preview and Make 3D. Smoother
 * motion: +10% on any plan (its share from /v1/pricing), and a preview
 * with it is never a free one. Classic is offered neither.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversion, Project, PublicPricing, StepConversionRequest, StepQuoteResponse } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { depthField, depthName, depthRunWords, isDepthChoice } from "@/lib/depthChoice";
import { runSummary } from "@/lib/glossary";
import { stabilizePct, stabilizeRunWords } from "@/lib/stabilize";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { DeliverPanel } from "./DeliverPanel";
import { LifelikeDeliverPanel } from "./LifelikeDeliverPanel";
import { LifelikePreviewPanel } from "./LifelikePreviewPanel";
import { sameOrder } from "./PreviousRuns";
import { QuoteView } from "./QuoteView";
import { detailRows } from "./RunDetails";
import { payLine } from "./useStepCheckout";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 30 }));

const PID = (projectFixture as { project_id: string }).project_id;
const DEPTH_HINT = "Standard suits most videos. Comfortable is easier on the eyes; Strong brings things further out.";
const STABILIZE_HINT = "Steadier 3D from frame to frame, with less flicker.";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  mockDb.tierPricing = true;
  resetPricingCache();
});
afterEach(() => {
  server.events.removeAllListeners();
  act(() => clearStepQuotes());
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  resetPricingCache();
});
afterAll(() => server.close());

function lifelikeProject(): Project {
  const p = mockDb.projects.get(PID)!;
  p.method = "lifelike";
  return structuredClone({ ...p, conversions: [] });
}

function capture(suffix: string): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(suffix)) {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
    }
  });
  return bodies;
}

function quote(breakdown: Record<string, unknown>, amount: number): StepQuoteResponse {
  return {
    step: "production",
    method: "lifelike",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: {
      amount_cents: amount,
      currency: "usd",
      breakdown: {
        step: "production", preset: "4k", billable_seconds: 120, fps_factor: 1,
        list_cents_per_minute: 1000, cents_per_minute: 1000, list_base_cents: 2000,
        discount: null, ...breakdown,
      },
    },
    reuse_stages: null,
    tier: "",
    discount: null,
  };
}

describe("Make 3D: the 3D depth", () => {
  it("Standard by default and not sent; Strong is sent on the quote and the run", async () => {
    const quotes = capture("/quotes");
    const runs = capture("/conversions");
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={lifelikeProject()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const control = await screen.findByTestId("depth-choice");
    expect(control.textContent).toContain("3D depth");
    expect(control.textContent).toContain(DEPTH_HINT);
    const radios = within(control).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Comfortable", "Standard", "Strong"]);
    expect(within(control).getByRole("radio", { name: "Standard" }).getAttribute("aria-checked")).toBe("true");
    await screen.findByTestId("quote-total", {}, { timeout: 3000 });
    expect(quotes.some((q) => q.depth !== undefined)).toBe(false);
    const before = screen.getByTestId("quote-total").textContent;

    fireEvent.click(within(control).getByRole("radio", { name: "Strong" }));
    await waitFor(() => expect(quotes.some((q) => q.step === "production" && q.depth === "strong")).toBe(true));
    expect(within(control).getByRole("radio", { name: "Strong" }).getAttribute("aria-checked")).toBe("true");
    // no price change
    await waitFor(() => expect(screen.getByTestId("quote-total").textContent).toBe(before));

    // a tap on the chosen one keeps it
    fireEvent.click(within(control).getByRole("radio", { name: "Strong" }));
    expect(within(control).getByRole("radio", { name: "Strong" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByTestId("checkout-main"));
    await waitFor(() => expect(runs.some((r) => r.depth === "strong")).toBe(true), { timeout: 3000 });
    await waitFor(() =>
      expect([...mockDb.conversions.values()].some((c) => c.params.depth === "strong" && c.params.max_disparity_pct === 5)).toBe(true),
    );
  });
});

describe("Make 3D: the Smoother motion add-on", () => {
  it("shows +10% with its line; ticking it prices the quote and the run sends it", async () => {
    const quotes = capture("/quotes");
    const runs = capture("/conversions");
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={lifelikeProject()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const row = await screen.findByTestId("addon-stabilize");
    expect(row.textContent).toContain("Smoother motion");
    expect(row.textContent).toContain("+10%");
    expect(row.textContent).toContain(STABILIZE_HINT);
    const box = within(row).getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    await screen.findByTestId("quote-total", {}, { timeout: 3000 });
    expect(quotes.some((q) => q.stabilize !== undefined)).toBe(false);
    expect(screen.queryByTestId("quote-stabilize")).toBeNull();

    fireEvent.click(box);
    await waitFor(() => expect(quotes.some((q) => q.step === "production" && q.stabilize === true)).toBe(true));
    const line = await screen.findByTestId("quote-stabilize", {}, { timeout: 3000 });
    expect(line.textContent).toMatch(/^\+\$\d+\.\d\d$/);
    expect(screen.getByText("Smoother motion (+10%)")).toBeTruthy();

    fireEvent.click(screen.getByTestId("checkout-main"));
    await waitFor(() => expect(runs.some((r) => r.stabilize === true)).toBe(true), { timeout: 3000 });
    await waitFor(() => expect([...mockDb.conversions.values()].some((c) => c.params.stabilize === true)).toBe(true));
  });

  it("Classic: neither is offered", async () => {
    const p = structuredClone(projectFixture) as unknown as Project;
    delete (p as { method?: string }).method;
    mockDb.projects.get(PID)!.method = undefined;
    render(
      <AuthProvider>
        <DeliverPanel project={p} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    await screen.findByTestId("quote-breakdown", {}, { timeout: 3000 });
    expect(screen.queryByTestId("addon-stabilize")).toBeNull();
    expect(screen.queryByTestId("depth-choice")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Smoother motion|3D depth/);
  });
});

describe("Preview: depth and Smoother motion", () => {
  it("Smoother motion off by default (the first preview stays free); ticked, the preview is paid and sends it", async () => {
    const quotes = capture("/quotes");
    render(
      <AuthProvider>
        <LifelikePreviewPanel project={lifelikeProject()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const row = await screen.findByTestId("preview-stabilize");
    expect(row.textContent).toContain("Smoother motion");
    expect(row.textContent).toContain("+10%");
    expect(row.textContent).toContain(STABILIZE_HINT);
    await waitFor(() => expect(screen.getByTestId("checkout-main").textContent).toBe("Preview this moment · Free"));
    fireEvent.click(within(row).getByRole("checkbox"));
    await waitFor(() =>
      expect(quotes.some((q) => q.step === "lifelike_preview" && q.stabilize === true)).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("checkout-main").textContent).toMatch(/^Preview this moment · \$\d+\.\d\d$/));
  });

  it("the depth: sent on the preview, still free, and the same pick Make 3D shows", async () => {
    const quotes = capture("/quotes");
    const preview = render(
      <AuthProvider>
        <LifelikePreviewPanel project={lifelikeProject()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const control = await screen.findByTestId("depth-choice");
    expect(control.textContent).toContain(DEPTH_HINT);
    fireEvent.click(within(control).getByRole("radio", { name: "Comfortable" }));
    await waitFor(() =>
      expect(quotes.some((q) => q.step === "lifelike_preview" && q.depth === "comfortable")).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("checkout-main").textContent).toBe("Preview this moment · Free"));
    preview.unmount();

    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={lifelikeProject()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const make = await screen.findByTestId("depth-choice");
    expect(within(make).getByRole("radio", { name: "Comfortable" }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(quotes.some((q) => q.step === "production" && q.depth === "comfortable")).toBe(true));
  });
});

describe("the gateway mock", () => {
  const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
  const post = (body: Record<string, unknown>) =>
    fetch(`${GATEWAY}/v1/projects/${PID}/quotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("refuses both on Classic (400 feature_unavailable)", async () => {
    mockDb.projects.get(PID)!.method = undefined;
    for (const extra of [{ stabilize: true }, { depth: "strong" }]) {
      const res = await post({ step: "production", preset: "1080p", ...extra });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("feature_unavailable");
    }
  });

  it("refuses a depth that isn't one of the three", async () => {
    mockDb.projects.get(PID)!.method = "lifelike";
    const res = await post({ step: "production", preset: "1080p", depth: "max" });
    expect(res.status).toBe(400);
  });

  it("prices Smoother motion at +10% of the list base; its preview is never free", async () => {
    mockDb.projects.get(PID)!.method = "lifelike";
    const paid = (await (await post({ step: "production", preset: "1080p", stabilize: true })).json()) as StepQuoteResponse;
    const b = paid.quote.breakdown!;
    expect(b.stabilize).toBe(true);
    expect(b.stabilize_cents).toBe(Math.round((b.list_base_cents ?? 0) * 0.1));
    expect(b.addons?.stabilize).toBe(b.stabilize_cents);
    expect(b.stabilize_label).toBe("Smoother motion +10%");

    const free = (await (await post({ step: "lifelike_preview", preset: "1080p", from_frame: 0, to_frame: 120 })).json()) as StepQuoteResponse;
    expect(free.quote.amount_cents).toBe(0);
    const pv = (await (await post({ step: "lifelike_preview", preset: "1080p", from_frame: 0, to_frame: 120, stabilize: true })).json()) as StepQuoteResponse;
    expect(pv.quote.amount_cents).toBeGreaterThan(0);
    expect(pv.quote.breakdown?.free_preview).toBeUndefined();
    expect(pv.free_previews?.free).toBe(false);
  });
});

describe("the quote line", () => {
  it("charged: its share and amount", () => {
    render(<QuoteView result={quote({ addons: { stabilize: 200 }, stabilize: true, stabilize_cents: 200, stabilize_label: "Smoother motion +10%", subtotal_cents: 2200 }, 2200)} />);
    expect(screen.getByTestId("quote-stabilize").textContent).toBe("+$2.00");
    expect(screen.getByText("Smoother motion (+10%)")).toBeTruthy();
    expect(screen.getByTestId("quote-total").textContent).toBe("$22.00");
  });

  it("none: no line", () => {
    render(<QuoteView result={quote({ addons: {}, stabilize: false, subtotal_cents: 2000 }, 2000)} />);
    expect(screen.queryByTestId("quote-stabilize")).toBeNull();
  });
});

describe("runs: details, history and the pay sheet", () => {
  const run = (params: Partial<Conversion["params"]>): Conversion => ({
    conversion_id: "conv0000stabil01",
    state: "succeeded",
    kind: "video",
    project_id: PID,
    step: "production",
    method: "lifelike",
    params: { preset: "1080p", formats: ["mvhevc"], ...params },
    quote: { amount_cents: 1500, currency: "usd" },
    billing: { status: "charged", charged_cents: 1500 },
    progress: 1,
    outputs: ["mvhevc"],
    created_at: "2026-11-10T09:00:00Z",
    updated_at: "2026-11-10T09:10:00Z",
  });
  const row = (c: Conversion, id: string) => detailRows(lifelikeProject(), c).find((r) => r.id === id)?.value ?? null;

  it("Run details: the 3D depth when the run says it, Smoother motion On or Off", () => {
    expect(row(run({ depth: "comfortable" }), "3D depth")).toBe("Comfortable");
    expect(row(run({ depth: "strong" }), "3D depth")).toBe("Strong");
    expect(row(run({}), "3D depth")).toBeNull();
    expect(row(run({ stabilize: true }), "Smoother motion")).toBe("On");
    expect(row(run({}), "Smoother motion")).toBe("Off");
  });

  it("history and the pay sheet name them", () => {
    expect(depthRunWords({ depth: "standard" })).toBe("3D depth: Standard");
    expect(depthRunWords({})).toBeNull();
    expect(stabilizeRunWords({ stabilize: true })).toBe("Smoother motion");
    expect(stabilizeRunWords({})).toBeNull();
    const summary = runSummary(run({ depth: "comfortable", stabilize: true }).params, "production");
    expect(summary).toContain("3D depth: Comfortable");
    expect(summary).toContain("Smoother motion");
    expect(runSummary(run({}).params, "production")).not.toMatch(/3D depth|Smoother motion/);
    expect(payLine(run({ stabilize: true }))).toMatch(/· Smoother motion$/);
    expect(payLine(run({}))).not.toContain("Smoother motion");
  });

  it("Previous runs: another depth or Smoother motion is another order; older runs were made at Strong", () => {
    const ask = (over: Partial<StepConversionRequest>): StepConversionRequest => ({
      step: "production", preset: "1080p", formats: ["mvhevc"], ...over,
    });
    expect(sameOrder(run({ depth: "standard" }), ask({}), 300)).toBe(true);
    expect(sameOrder(run({ depth: "standard" }), ask({ depth: "strong" }), 300)).toBe(false);
    expect(sameOrder(run({}), ask({}), 300)).toBe(false);
    expect(sameOrder(run({}), ask({ depth: "strong" }), 300)).toBe(true);
    expect(sameOrder(run({ depth: "standard" }), ask({ stabilize: true }), 300)).toBe(false);
    expect(sameOrder(run({ depth: "standard", stabilize: true }), ask({}), 300)).toBe(false);
    expect(sameOrder(run({ depth: "standard", stabilize: true }), ask({ stabilize: true }), 300)).toBe(true);
  });
});

describe("helpers", () => {
  it("the depth request field leaves Standard out", () => {
    expect(depthField("standard")).toEqual({});
    expect(depthField("comfortable")).toEqual({ depth: "comfortable" });
    expect(depthField("strong")).toEqual({ depth: "strong" });
    expect(isDepthChoice("strong")).toBe(true);
    expect(isDepthChoice("max")).toBe(false);
    expect(isDepthChoice(undefined)).toBe(false);
    expect(depthName("comfortable")).toBe("Comfortable");
  });

  it("Smoother motion's share comes from /v1/pricing, for Lifelike only", () => {
    const pricing = (addon: Record<string, unknown> | undefined) =>
      ({ addons: addon ? { stabilize: addon } : {} }) as unknown as PublicPricing;
    expect(stabilizePct(pricing({ pct: 0.1, methods: ["lifelike"] }))).toBe(0.1);
    expect(stabilizePct(pricing({ pct: 0.2 }))).toBe(0.2);
    expect(stabilizePct(pricing({ pct: 0.1, methods: ["classic"] }))).toBeNull();
    expect(stabilizePct(pricing({ pct: 0.1, enabled: false }))).toBeNull();
    expect(stabilizePct(pricing(undefined))).toBeNull();
    expect(stabilizePct(null)).toBeNull();
  });
});
