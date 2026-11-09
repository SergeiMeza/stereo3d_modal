/**
 * Commercial use (owner 2026-11-09): +50% on any plan, Lifelike runs and
 * previews only, no intro clip. Plans active on 2026-11-09 keep it
 * included until their renewal. Classic isn't offered it, and no plan
 * copy promises it any more.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { planIncludes } from "@/components/business/BusinessSetup";
import { PERSONAL_USE_LINE } from "@/components/pay/payCopy";
import { planLines } from "@/components/pricing/PlansSection";
import type { AccountPlan, Conversion, Project, StepQuoteResponse } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { commercialIncludedLine, commercialIncludedUntil, commercialRunWords } from "@/lib/commercial";
import { runSummary } from "@/lib/glossary";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import en from "../../../messages/en.json";
import projectFixture from "../../../fixtures/project.json";

import { clearStepQuotes } from "./checkoutStore";
import { DeliverPanel } from "./DeliverPanel";
import { LifelikeDeliverPanel } from "./LifelikeDeliverPanel";
import { LifelikePreviewPanel } from "./LifelikePreviewPanel";
import { QuoteView } from "./QuoteView";
import { detailRows } from "./RunDetails";
import { payLine } from "./useStepCheckout";

vi.mock("./polling", () => ({ POLL_INTERVAL_MS: 30 }));

const PID = (projectFixture as { project_id: string }).project_id;
const NEXT_YEAR = new Date(Date.now() + 200 * 86_400_000).toISOString();

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

/** A Business plan active on 2026-11-09: Commercial use included until
 * its renewal. */
function grandfatheredPlan(): AccountPlan {
  return {
    plan: "business", name: "Business", status: "active", active: true, monthly_cents: 29900,
    credit_cents: 40000, credit_left_cents: 40000, cancel_at_period_end: false,
    current_period_end: NEXT_YEAR, commercial_included_until: NEXT_YEAR,
  };
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

describe("Make 3D: the Commercial use add-on", () => {
  it("shows +50% with its line; ticking it prices the quote and the run sends it", async () => {
    const quotes = capture("/quotes");
    const runs = capture("/conversions");
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={lifelikeProject()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const row = await screen.findByTestId("addon-commercial");
    expect(row.textContent).toContain("Commercial use");
    expect(row.textContent).toContain("+50%");
    expect(row.textContent).toContain(
      "You may use the video commercially, and it has no Spatial Video Studio intro clip.",
    );
    const box = within(row).getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    await screen.findByTestId("quote-total", {}, { timeout: 3000 });
    expect(quotes.some((q) => q.commercial !== undefined)).toBe(false);
    expect(screen.queryByTestId("quote-commercial")).toBeNull();

    fireEvent.click(box);
    await waitFor(() => expect(quotes.some((q) => q.step === "production" && q.commercial === true)).toBe(true));
    const line = await screen.findByTestId("quote-commercial", {}, { timeout: 3000 });
    expect(line.textContent).toMatch(/^\+\$\d+\.\d\d$/);
    expect(screen.getByText("Commercial use (+50%)")).toBeTruthy();

    fireEvent.click(screen.getByTestId("checkout-main"));
    await waitFor(() => expect(runs.some((r) => r.commercial === true)).toBe(true), { timeout: 3000 });
    await waitFor(() => expect([...mockDb.conversions.values()].some((c) => c.params.commercial === true)).toBe(true));
  });

  it("a plan that still includes it: ticked, fixed and included, no charge", async () => {
    mockDb.billing.plan = grandfatheredPlan();
    render(
      <AuthProvider>
        <BillingProvider>
          <LifelikeDeliverPanel project={lifelikeProject()} onProjectChanged={() => {}} />
        </BillingProvider>
      </AuthProvider>,
    );
    const row = await screen.findByTestId("addon-commercial");
    await waitFor(() => expect(row.textContent).toContain(commercialIncludedLine(NEXT_YEAR)));
    expect(row.textContent).toMatch(/Included with your plan until \w{3} \d{1,2}, \d{4}/);
    expect(row.textContent).not.toContain("+50%");
    const box = within(row).getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId("quote-commercial").textContent).toBe("Included"), { timeout: 3000 });
    expect(screen.queryByText("Commercial use (+50%)")).toBeNull();
  });

  it("Classic: not offered", async () => {
    const p = structuredClone(projectFixture) as unknown as Project;
    delete (p as { method?: string }).method;
    mockDb.projects.get(PID)!.method = undefined;
    render(
      <AuthProvider>
        <DeliverPanel project={p} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    await screen.findByTestId("quote-breakdown", {}, { timeout: 3000 });
    expect(screen.queryByTestId("addon-commercial")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Commercial use/);
  });
});

describe("Preview: the Commercial use add-on", () => {
  it("off by default (the first preview stays free); ticked, the preview is priced and sends it", async () => {
    const quotes = capture("/quotes");
    render(
      <AuthProvider>
        <LifelikePreviewPanel project={lifelikeProject()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const row = await screen.findByTestId("preview-commercial");
    expect(row.textContent).toContain("+50%");
    await waitFor(() => expect(screen.getByTestId("checkout-main").textContent).toBe("Preview this moment · Free"));
    fireEvent.click(within(row).getByRole("checkbox"));
    await waitFor(() =>
      expect(quotes.some((q) => q.step === "lifelike_preview" && q.commercial === true)).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("checkout-main").textContent).toMatch(/^Preview this moment · \$\d+\.\d\d$/));
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

  it("refuses Commercial use on Classic (400 feature_unavailable)", async () => {
    mockDb.projects.get(PID)!.method = undefined;
    const res = await post({ step: "production", preset: "1080p", commercial: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("feature_unavailable");
  });

  it("prices it at +50% of the list base; a grandfathered plan gets it included", async () => {
    mockDb.projects.get(PID)!.method = "lifelike";
    const paid = (await (await post({ step: "production", preset: "1080p", commercial: true })).json()) as StepQuoteResponse;
    const b = paid.quote.breakdown!;
    expect(b.commercial).toBe(true);
    expect(b.commercial_included).toBe(false);
    expect(b.commercial_cents).toBe(Math.round((b.list_base_cents ?? 0) * 0.5));
    expect(b.addons?.commercial).toBe(b.commercial_cents);
    expect(b.commercial_label).toBe("Commercial use +50%");

    mockDb.billing.plan = grandfatheredPlan();
    const incl = (await (await post({ step: "production", preset: "1080p" })).json()) as StepQuoteResponse;
    expect(incl.quote.breakdown?.commercial).toBe(true);
    expect(incl.quote.breakdown?.commercial_included).toBe(true);
    expect(incl.quote.breakdown?.addons?.commercial).toBeUndefined();
  });
});

describe("the quote line", () => {
  it("charged: its share and amount", () => {
    render(<QuoteView result={quote({ addons: { commercial: 1000 }, commercial: true, commercial_included: false, commercial_cents: 1000, commercial_label: "Commercial use +50%", subtotal_cents: 3000 }, 3000)} />);
    expect(screen.getByTestId("quote-commercial").textContent).toBe("+$10.00");
    expect(screen.getByText("Commercial use (+50%)")).toBeTruthy();
    expect(screen.getByTestId("quote-total").textContent).toBe("$30.00");
  });

  it("included: no charge", () => {
    render(<QuoteView result={quote({ addons: {}, commercial: true, commercial_included: true, subtotal_cents: 2000 }, 2000)} />);
    expect(screen.getByTestId("quote-commercial").textContent).toBe("Included");
    expect(screen.getByText("Commercial use")).toBeTruthy();
  });

  it("none: no line", () => {
    render(<QuoteView result={quote({ addons: {}, commercial: false, commercial_included: false, subtotal_cents: 2000 }, 2000)} />);
    expect(screen.queryByTestId("quote-commercial")).toBeNull();
  });
});

describe("runs: details, history and the pay sheet", () => {
  const run = (params: Partial<Conversion["params"]>): Conversion => ({
    conversion_id: "conv0000commerc1",
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
    created_at: "2026-11-09T09:00:00Z",
    updated_at: "2026-11-09T09:10:00Z",
  });
  const row = (c: Conversion) =>
    detailRows(lifelikeProject(), c).find((r) => r.id === "Commercial use")?.value ?? null;

  it("Run details say On, Off or Included", () => {
    expect(row(run({ commercial: true }))).toBe("On");
    expect(row(run({ commercial: true, commercial_included: true }))).toBe("Included");
    expect(row(run({}))).toBe("Off");
  });

  it("history and the pay sheet name it", () => {
    expect(commercialRunWords({ commercial: true })).toBe("Commercial use");
    expect(commercialRunWords({ commercial: true, commercial_included: true })).toBe("Commercial use (included)");
    expect(commercialRunWords({})).toBeNull();
    expect(runSummary(run({ commercial: true }).params, "production")).toContain("Commercial use");
    expect(runSummary(run({ commercial: true, commercial_included: true }).params, "production")).toContain(
      "Commercial use (included)",
    );
    expect(runSummary(run({}).params, "production")).not.toContain("Commercial use");
    expect(payLine(run({ commercial: true }))).toMatch(/· Commercial use$/);
  });

  it("an included date only while it's ahead and the plan is active", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(commercialIncludedUntil({ active: true, commercial_included_until: NEXT_YEAR })).toBe(NEXT_YEAR);
    expect(commercialIncludedUntil({ active: true, commercial_included_until: past })).toBeNull();
    expect(commercialIncludedUntil({ active: false, commercial_included_until: NEXT_YEAR })).toBeNull();
    expect(commercialIncludedUntil({ active: true })).toBeNull();
    expect(commercialIncludedLine(null)).toBe("Included with your plan");
  });
});

describe("plan copy no longer promises commercial use (owner 2026-11-09)", () => {
  const studio = {
    name: "Studio", monthly_cents: 99900, credit_cents: 150000, max_active_runs: 8,
    free_previews_per_period: 200, express_included: true, max_fps: 120,
  };

  it("plan cards and the setup's list leave it out", () => {
    expect(planLines(studio, 0.25).join(" ")).not.toMatch(/commercial/i);
    expect(planIncludes("studio", studio, null).join(" ")).not.toMatch(/commercial/i);
  });

  it("only the add-on's own messages mention it", () => {
    const hits: string[] = [];
    const walk = (o: Record<string, unknown>, path: string) => {
      for (const [k, v] of Object.entries(o)) {
        const key = path ? `${path}.${k}` : k;
        if (typeof v === "string" && /commercial/i.test(v)) hits.push(key);
        else if (v && typeof v === "object") walk(v as Record<string, unknown>, key);
      }
    };
    walk(en as Record<string, unknown>, "");
    expect(hits.sort()).toEqual(
      [
        "business.setup.welcome.commercialAddOn",
        "commercial.anyPlan",
        "commercial.hint",
        "commercial.name",
        "commercial.runIncluded",
        "files.details.rows.commercial",
        "pay.copy.personalUseAddOn",
        "pricing.extras.commercialWhat",
      ].sort(),
    );
    // none of them ties it to a plan
    expect(PERSONAL_USE_LINE).toBe("For personal use. Commercial use is an add-on for Lifelike 3D videos.");
  });
});
