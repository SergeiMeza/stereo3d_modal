/**
 * Plans and paywalls, the starting set (plans canvas, 2026-11-04): who sees
 * which surface, dismissals kept on the account, prices from the quote and
 * the tier rates, and pay once as the default.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { LifelikeDeliverPanel } from "@/components/steps/LifelikeDeliverPanel";
import type { Project, StepQuoteResponse } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider, resetBillingForTests } from "@/lib/billing";
import { resetProForTests } from "@/lib/pro/usePro";
import { resetAccountSettingsCache } from "@/lib/useAccountSettings";
import { MOCK_PRO_PLANS, mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { UserMenu } from "@/components/auth/UserMenu";

import { HeaderPlans } from "./HeaderPlans";
import { PlansBanner } from "./PlansBanner";
import { TalkToUs } from "./TalkToUs";
import { ProSavingsCard } from "./ProSavingsCard";
import { BusinessNote, CinemaTierPrices, proTodayOffer } from "./QuotePlans";
import { plansFromPricing } from "@/lib/pro/plans";
import { SourceBusinessLine } from "./SourceBusinessLine";
import {
  clearLocalProjectDismissals,
  isCompanyEmail,
  isDismissed,
  saveRange,
  sourceReason,
  sourceSizeWord,
  tierPriceFor,
} from "./upsell";
import { NUDGE_SURFACE } from "./PlanNudge";
import { ProjectsNudge } from "./ProjectsNudge";
import { BUSINESS_SIZED_CENTS } from "./TalkToUs";
import { authStateAtom } from "@/lib/auth";
import { appStore } from "@/lib/state/stores";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));
vi.mock("@/components/steps/polling", () => ({ POLL_INTERVAL_MS: 30 }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  resetAccountSettingsCache();
  resetPricingCache();
  resetProForTests();
  mockDb.tierPricing = true;
  mockDb.accountSettings.hints_seen = [];
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const wrap = (el: React.ReactElement) =>
  render(
    <AuthProvider>
      <BillingProvider>{el}</BillingProvider>
    </AuthProvider>,
  );

function webPro(): void {
  mockDb.billing.plan = {
    plan: "pro",
    plan_id: "pro_monthly",
    name: "Pro Monthly",
    status: "active",
    active: true,
    monthly_cents: 1499,
    credit_cents: 0,
    credit_left_cents: 0,
    cancel_at_period_end: false,
  } as never;
}

function studio(): void {
  mockDb.billing.plan = {
    plan: "studio",
    name: "Studio",
    status: "active",
    active: true,
    monthly_cents: 99900,
    credit_cents: 150000,
    credit_left_cents: 150000,
    cancel_at_period_end: false,
  };
}

function business(): void {
  mockDb.billing.plan = {
    plan: "business",
    name: "Business",
    status: "active",
    active: true,
    monthly_cents: 29900,
    credit_cents: 40000,
    credit_left_cents: 40000,
    cancel_at_period_end: false,
  };
}

describe("pure rules", () => {
  it("the save range comes from the tier shares", () => {
    expect(
      saveRange({
        tiers: { classic_pct: { pro: 0.15, business: 0.2, studio: 0.25 } },
      } as never),
    ).toBe("15–25%");
    expect(saveRange(null)).toBeNull();
  });

  it("dated dismissals come back after their days", () => {
    const now = new Date(Date.UTC(2026, 10, 12));
    expect(isDismissed("2026-11-04T09:00:00Z", 7, now)).toBe(false);
    expect(isDismissed("2026-11-08T09:00:00Z", 7, now)).toBe(true);
    expect(isDismissed("2026-01-01T00:00:00Z", null, now)).toBe(true);
    expect(isDismissed(undefined, 7, now)).toBe(false);
  });

  it("company email domains", () => {
    expect(isCompanyEmail("maya@northlight-films.com")).toBe(true);
    for (const e of [
      "a@gmail.com",
      "b@outlook.com",
      "c@icloud.com",
      "d@yahoo.co.jp",
      "e@qq.com",
      "f@163.com",
    ]) {
      expect(isCompanyEmail(e)).toBe(false);
    }
  });

  it("a Pro price from the quote and the tier rates", () => {
    const quote = {
      step: "production",
      params: { preset: "4k", formats: ["mvhevc"] },
      quote: {
        // gateway 00166: 3 min at 4K's $16.00 list price
        amount_cents: 4800,
        currency: "usd",
        breakdown: {
          preset: "4k",
          billable_minutes: 3,
          fps_factor: 1,
          subtotal_cents: 4800,
          addons: {},
        },
      },
    } as unknown as StepQuoteResponse;
    const pricing = {
      tiers: {
        order: [],
        classic_pct: {},
        lifelike_cents_per_minute: {
          pro: { "4k": 850 },
          business: { "4k": 800 },
        },
      },
      discount: { threshold_cents: 5000, pct: 0.1 },
      minimum_cents: 100,
    } as never;
    expect(tierPriceFor(quote, pricing, "pro")).toBe(2550);
    expect(tierPriceFor(quote, pricing, "business")).toBe(2400);
    expect(
      tierPriceFor(
        { ...quote, step: "lifelike_preview" } as StepQuoteResponse,
        pricing,
        "pro",
      ),
    ).toBeNull();
  });

  it("the gateway's alt_prices win over the composed price", () => {
    const quote = {
      step: "production",
      params: { preset: "4k" },
      quote: {
        amount_cents: 3000,
        currency: "usd",
        breakdown: {
          preset: "4k",
          billable_minutes: 3,
          subtotal_cents: 3000,
          addons: {},
        },
      },
      alt_prices: { pro: 2549, business: 2399, studio: 2249 },
    } as unknown as StepQuoteResponse;
    expect(tierPriceFor(quote, null, "pro")).toBe(2549);
    expect(tierPriceFor(quote, null, "studio")).toBe(2249);
  });
});

describe("header B", () => {
  it("shows Plans with the save chip to people without a plan", async () => {
    wrap(<HeaderPlans />);
    expect((await screen.findByTestId("header-save-chip")).textContent).toBe(
      "Save 15–25%",
    );
    expect(screen.getByTestId("header-plans").getAttribute("href")).toBe(
      "/plans",
    );
  });

  it("renders no link while the plan is still loading", async () => {
    wrap(<HeaderPlans />);
    expect(screen.queryByTestId("header-plans")).toBeNull();
    // let the billing answer land in this test, not the next one
    expect(await screen.findByTestId("header-plans")).toBeTruthy();
  });

  it.each([
    ["Business", business],
    ["web Pro", webPro],
    ["Studio", studio],
  ])("a %s subscriber gets no header link", async (_name, setUp) => {
    setUp();
    wrap(<HeaderPlans />);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("header-plans")).toBeNull();
    // the header's paywall events only fire when the link renders
    expect(mockDb.events.filter((e) => e.props.placement === "header")).toEqual([]);
  });

  it("signed-out visitors keep the Plans link, without the chip", async () => {
    appStore.set(authStateAtom, (a) => ({ ...a, user: null, ready: true }));
    wrap(<HeaderPlans />);
    expect(screen.getByTestId("header-plans").getAttribute("href")).toBe("/plans");
    // let the pricing answer land in this test, not the next one
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByTestId("header-save-chip")).toBeNull();
  });
});

describe("account menu (owner 2026-11-05)", () => {
  it.each([
    ["no plan", () => {}],
    ["Business", business],
    ["web Pro", webPro],
  ])("is Account, Plan & billing, Sign out with %s", async (_name, setUp) => {
    setUp();
    wrap(<UserMenu />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Account menu" }), { key: "Enter" });
    const menu = within(screen.getByTestId("account-menu"));
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Account",
      "Plan & billing",
      "Sign out",
    ]);
    expect(menu.getByRole("menuitem", { name: "Plan & billing" }).getAttribute("href")).toBe(
      "/account/billing",
    );
  });
});

describe("projects A", () => {
  it("dismisses to one line, kept on the account", async () => {
    wrap(<PlansBanner />);
    // owner 2026-11-07: the monthly credit, from /v1/pricing
    expect((await screen.findByTestId("plans-banner")).textContent).toContain(
      "Pro takes 15% off every video and includes $20 credit to start.",
    );
    fireEvent.click(screen.getByTestId("plans-banner-dismiss"));
    expect(await screen.findByTestId("plans-line")).toBeTruthy();
    await waitFor(() =>
      expect(mockDb.accountSettings.dismissed.projects_banner).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      ),
    );
  });

  it("isn't shown with a plan", async () => {
    business();
    wrap(<PlansBanner />);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("plans-banner")).toBeNull();
    expect(screen.queryByTestId("plans-line")).toBeNull();
  });
});

describe("quote A and the Business note", () => {
  function project(): Project {
    const p = mockDb.projects.get(
      (projectFixture as unknown as Project).project_id,
    )!;
    p.method = "lifelike";
    return structuredClone({ ...p, conversions: [] });
  }

  it("pay once is selected; With Pro turns the button into Get the plan and convert; nothing is charged", async () => {
    wrap(
      <LifelikeDeliverPanel project={project()} onProjectChanged={() => {}} />,
    );
    const once = await screen.findByTestId("pay-once", undefined, {
      timeout: 4000,
    });
    expect(once.getAttribute("aria-checked")).toBe("true");
    const main = screen.getByTestId("checkout-main");
    expect(main.textContent).toMatch(/^Make 3D · \$/);
    fireEvent.click(screen.getByTestId("pay-with-pro"));
    expect(screen.getByTestId("checkout-main").textContent).toBe(
      "Get the plan and convert",
    );
    const before = mockDb.conversions.size;
    fireEvent.click(screen.getByTestId("checkout-main"));
    expect(await screen.findByTestId("pro-checkout")).toBeTruthy();
    expect(mockDb.conversions.size).toBe(before);
    fireEvent.click(screen.getByTestId("pro-checkout-pay-once"));
    await waitFor(() =>
      expect(screen.getByTestId("checkout-main").textContent).toMatch(
        /^Make 3D · \$/,
      ),
    );
  });

  it("With Pro shows the gateway's alt_prices", async () => {
    mockDb.altPricesFixed = { pro: 1234 };
    wrap(
      <LifelikeDeliverPanel project={project()} onProjectChanged={() => {}} />,
    );
    const pro = await screen.findByTestId("pay-with-pro", undefined, {
      timeout: 4000,
    });
    expect(pro.textContent).toContain("$12.34");
  });

  it("a new account's first full-run quote offers Pro beside the free-preview line (TEST 2026-11-07)", async () => {
    // the gateway sends free_previews on every quote; a new account's says
    // the first preview is free, on the full run's quote too
    wrap(
      <LifelikeDeliverPanel project={project()} onProjectChanged={() => {}} />,
    );
    const pro = await screen.findByTestId("pay-with-pro", undefined, { timeout: 4000 });
    expect(pro).toBeTruthy();
    expect(screen.getByTestId("free-previews").textContent).toBe("Your first preview is free");
    cleanup();
    // and the same once the free preview is used
    mockDb.freePreviews.introUsed = true;
    resetAccountSettingsCache();
    wrap(
      <LifelikeDeliverPanel project={project()} onProjectChanged={() => {}} />,
    );
    expect(await screen.findByTestId("pay-with-pro", undefined, { timeout: 4000 })).toBeTruthy();
  });

  it("With Pro shows what's paid today when Pro's credit covers the video (BUX-09)", async () => {
    mockDb.altPricesFixed = { pro: 1020 };
    wrap(
      <LifelikeDeliverPanel project={project()} onProjectChanged={() => {}} />,
    );
    const pro = await screen.findByTestId("pay-with-pro", undefined, { timeout: 4000 });
    await waitFor(() =>
      expect(pro.textContent).toBe(
        "With ProThis video ($10.20) comes from your $20 Pro credit · then $4.99 a month$4.99 today",
      ),
    );
    // Pay once keeps its price and stays selected
    const once = screen.getByTestId("pay-once");
    expect(once.getAttribute("aria-checked")).toBe("true");
    expect(once.textContent).not.toContain("today");
    // the Pro sheet says the video comes from the credit
    fireEvent.click(pro);
    fireEvent.click(screen.getByTestId("checkout-main"));
    const row = await screen.findByTestId("pro-checkout-from-credit");
    expect(row.textContent).toBe("From your $20 Pro credit−$10.20");
  });

  it("no today offer when the credit doesn't cover it, or the account had it already (BUX-09)", async () => {
    // already granted once: joining again gives no credit
    mockDb.altPricesFixed = { pro: 1020 };
    mockDb.proCredit = {
      cents: 2000, kind: "pro_monthly", source: "web", trial: false, granted: true,
      granted_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-31T00:00:00Z", left_cents: 0,
    };
    wrap(
      <LifelikeDeliverPanel project={project()} onProjectChanged={() => {}} />,
    );
    const pro = await screen.findByTestId("pay-with-pro", undefined, { timeout: 4000 });
    await waitFor(() => expect(pro.textContent).toContain("$10.20"));
    expect(pro.textContent).not.toContain("today");
    expect(proTodayOffer(2500, plansFromPricing(MOCK_PRO_PLANS)[1], 2000, true)).toBeNull();
    expect(proTodayOffer(1020, plansFromPricing(MOCK_PRO_PLANS)[1], 2000, true)).toEqual({ todayCents: 499, creditCents: 2000 });
    expect(proTodayOffer(1020, plansFromPricing(MOCK_PRO_PLANS)[1], 2000, false)).toBeNull();
  });

  it("a $50+ quote carries the Business note", async () => {
    const p = project();
    p.probe = {
      ...p.probe!,
      duration_s: 600,
      num_frames: Math.round(600 * p.probe!.fps),
    };
    mockDb.projects.get(p.project_id)!.probe = p.probe;
    wrap(<LifelikeDeliverPanel project={p} onProjectChanged={() => {}} />);
    const note = await screen.findByTestId("business-note", undefined, {
      timeout: 4000,
    });
    expect(note.textContent).toContain(
      "Business and Studio include monthly usage.",
    );
    expect(note.textContent).toMatch(/At Business prices this video is \$/);
  });
});

describe("talk to us", () => {
  it("posts message, company and team size to /v1/contact", async () => {
    wrap(<TalkToUs />);
    fireEvent.click(await screen.findByTestId("talk-to-us-open"));
    fireEvent.change(screen.getByTestId("talk-to-us-message"), {
      target: { value: "Ten 4K videos a month" },
    });
    fireEvent.change(screen.getByTestId("talk-to-us-company"), {
      target: { value: "Northlight" },
    });
    fireEvent.change(screen.getByTestId("talk-to-us-team"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("talk-to-us-send"));
    expect(await screen.findByTestId("talk-to-us-sent")).toBeTruthy();
    expect(mockDb.events.find((e) => e.name === "contact")?.props).toEqual({
      topic: "business",
      message: "Ten 4K videos a month",
      company: "Northlight",
      team_size: "4",
    });
  });

  it("shows the gateway's message on 429, no mailto", async () => {
    for (let i = 0; i < 5; i++)
      mockDb.events.push({
        name: "contact",
        props: {},
        at: new Date().toISOString(),
      });
    wrap(<TalkToUs />);
    fireEvent.click(await screen.findByTestId("talk-to-us-open"));
    fireEvent.change(screen.getByTestId("talk-to-us-message"), {
      target: { value: "Hi" },
    });
    fireEvent.click(screen.getByTestId("talk-to-us-send"));
    expect(
      (await screen.findByTestId("talk-to-us-error")).textContent,
    ).toContain("support@");
    expect(screen.queryByTestId("talk-to-us-sent")).toBeNull();
  });
});

describe("receipt A", () => {
  it("names what Pro would have saved on a billed run", async () => {
    const p = mockDb.projects.get(
      (projectFixture as unknown as Project).project_id,
    )!;
    const run = {
      conversion_id: "billed1",
      project_id: p.project_id,
      step: "production",
      method: "lifelike",
      state: "succeeded",
      params: { preset: "4k", formats: ["mvhevc"] },
      quote: {
        amount_cents: 4800,
        currency: "usd",
        breakdown: {
          preset: "4k",
          billable_minutes: 3,
          fps_factor: 1,
          subtotal_cents: 4800,
          addons: {},
        },
      },
      billing: { status: "charged" },
      created_at: new Date().toISOString(),
    };
    wrap(
      <ProSavingsCard
        project={{ ...p, conversions: [run] } as unknown as Project}
      />,
    );
    expect((await screen.findByTestId("receipt-pro")).textContent).toContain(
      "You'd have saved $7.20 with Pro",
    );
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByTestId("receipt-pro")).toBeNull());
  });
});

describe("high-end sources guide to Business (owner 2026-11-04)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearLocalProjectDismissals();
  });

  function sourced(width: number, height: number, fps: number): Project {
    const p = structuredClone(
      mockDb.projects.get((projectFixture as unknown as Project).project_id)!,
    );
    p.project_id = `hi-${width}-${fps}`;
    p.probe = { ...p.probe!, width, height, fps };
    p.analyze = { ...p.analyze, state: "succeeded" };
    mockDb.projects.set(p.project_id, structuredClone(p));
    return p;
  }

  it("reasons and size words", () => {
    expect(sourceReason({ width: 3840, height: 2160, fps: 24 })).toBeNull();
    expect(sourceReason({ width: 7680, height: 4320, fps: 24 })).toBe(
      "source_8k",
    );
    expect(sourceReason({ width: 3840, height: 2160, fps: 60 })).toBe(
      "source_fps",
    );
    expect(sourceSizeWord({ width: 5120, height: 2880 })).toBe("5K");
    expect(sourceSizeWord({ width: 6144, height: 3240 })).toBe("6K");
    expect(sourceSizeWord({ width: 7680, height: 4320 })).toBe("8K");
  });

  it("an 8K source gets one line with the real shares; dismissed for that project only", async () => {
    const p = sourced(7680, 4320, 24);
    wrap(<SourceBusinessLine project={p} />);
    const line = await screen.findByTestId("source-business-line");
    expect(line.textContent).toContain("Working in 8K? Business and Studio save 20–25%.");
    // owner 2026-11-09: plans no longer include commercial use
    expect(line.textContent).not.toMatch(/commercial/i);
    await waitFor(() =>
      expect(
        mockDb.events.some(
          (e) =>
            e.name === "plans_surface_view" && e.props.reason === "source_8k",
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("source-business-line")).toBeNull();
    // kept on the account under the project's own key (gateway 00098)
    await waitFor(() =>
      expect(
        mockDb.accountSettings.dismissed[`business_note:${p.project_id}`],
      ).toMatch(/^\d{4}-/),
    );
    cleanup();
    wrap(<SourceBusinessLine project={sourced(7680, 4320, 25)} />);
    expect(await screen.findByTestId("source-business-line")).toBeTruthy();
  });

  it("a high frame rate source gets the frame-rate line", async () => {
    wrap(<SourceBusinessLine project={sourced(3840, 2160, 60)} />);
    expect(
      (await screen.findByTestId("source-business-line")).textContent,
    ).toContain(
      "High frame rates come with Business and Studio, which also save 20–25%.",
    );
  });

  it("not for Business subscribers", async () => {
    business();
    wrap(<SourceBusinessLine project={sourced(7680, 4320, 24)} />);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("source-business-line")).toBeNull();
  });

  const smallQuote = {
    step: "production",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: {
      amount_cents: 1000,
      currency: "usd",
      breakdown: {
        preset: "4k",
        billable_minutes: 1,
        subtotal_cents: 1000,
        addons: {},
      },
    },
    alt_prices: { pro: 850, business: 800, studio: 750 },
    output_seconds: 60,
  } as unknown as StepQuoteResponse;

  it("the Business note follows a high frame rate source, with its reason", async () => {
    const p = sourced(3840, 2160, 60);
    wrap(
      <BusinessNote
        quote={smallQuote}
        projectId={p.project_id}
        probe={p.probe}
      />,
    );
    expect((await screen.findByTestId("business-note")).textContent).toContain(
      "High frame rates come with Business and Studio",
    );
    await waitFor(() =>
      expect(
        mockDb.events.find(
          (e) =>
            e.name === "plans_surface_view" &&
            e.props.placement === "business_note",
        )?.props.reason,
      ).toBe("source_fps"),
    );
  });

  it("an 8K quote lists Business and Studio from alt_prices", async () => {
    const q = {
      ...smallQuote,
      params: { preset: "8k", formats: ["mvhevc"] },
      quote: {
        ...smallQuote.quote,
        breakdown: { ...smallQuote.quote.breakdown, preset: "8k" },
      },
      alt_prices: { pro: 2380, business: 2240, studio: 2100 },
    } as unknown as StepQuoteResponse;
    wrap(<CinemaTierPrices quote={q} projectId="p8k" />);
    expect(
      (await screen.findByTestId("cinema-business")).textContent,
    ).toContain("$22.40");
    expect(screen.getByTestId("cinema-studio").textContent).toContain("$21.00");
    // no alt_prices, nothing shown (never composed)
    cleanup();
    wrap(
      <CinemaTierPrices
        quote={{ ...q, alt_prices: undefined } as StepQuoteResponse}
        projectId="p8k2"
      />,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("cinema-tier-prices")).toBeNull();
  });
});

describe("one plan nudge at a time on Projects (owner 2026-11-05)", () => {
  it("Business for a business-looking account, Pro after it's dismissed, one look for both", async () => {
    // the mock account's address is a company one (example.com)
    wrap(<ProjectsNudge />);
    const biz = await screen.findByTestId("talk-to-us");
    expect(screen.queryByTestId("plans-banner")).toBeNull();
    expect(within(biz).getAllByRole("button").map((b) => b.textContent)).toEqual(["Talk to us", ""]);
    expect(within(biz).getAllByRole("link").map((l) => l.textContent)).toEqual(["See Business"]);
    fireEvent.click(screen.getByTestId("talk-to-us-dismiss"));
    const pro = await screen.findByTestId("plans-banner");
    expect(screen.queryByTestId("talk-to-us")).toBeNull();
    // the same surface, padding and type, the X in the same place
    const surface = (el: HTMLElement) => el.className.split(" ").filter((c) => NUDGE_SURFACE.split(" ").includes(c)).sort();
    expect(surface(pro)).toEqual(surface(biz));
    expect(pro.lastElementChild?.getAttribute("aria-label")).toBe("Dismiss");
    expect(biz.lastElementChild?.getAttribute("aria-label")).toBe("Dismiss");
  });


  it("a personal address gets Pro; saved business details or Business-sized usage make it Business", async () => {
    const personal = () =>
      appStore.set(authStateAtom, (a) => ({ ...a, user: a.user ? { ...a.user, email: "aiko@gmail.com" } : a.user }));
    personal();
    wrap(<ProjectsNudge />);
    expect(await screen.findByTestId("plans-banner")).toBeTruthy();
    expect(screen.queryByTestId("talk-to-us")).toBeNull();
    cleanup();
    resetAccountSettingsCache();
    mockDb.billing.company = { company_name: "Kyoto Films KK" };
    personal();
    wrap(<ProjectsNudge />);
    expect(await screen.findByTestId("talk-to-us")).toBeTruthy();
    cleanup();
    resetAccountSettingsCache();
    mockDb.billing.company = {};
    mockDb.billing.prepaid.month_spent_cents = BUSINESS_SIZED_CENTS;
    // a fresh page load reads billing again
    resetBillingForTests();
    personal();
    wrap(<ProjectsNudge />);
    expect(await screen.findByTestId("talk-to-us")).toBeTruthy();
  });
});
