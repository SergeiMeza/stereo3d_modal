/**
 * The launch offer (owner 2026-11-07, gateway 00175): −25% on web Lifelike
 * full videos at 1080p and 1440p until Jan 10. The quote shows the line,
 * the quality tiles and the price table a badge (prices unchanged), Run
 * details and Files the line the run had; nothing once it's inactive.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { clearStepQuotes } from "@/components/steps/checkoutStore";
import { LifelikePrices } from "@/components/pricing/PerMinutePrices";
import { LifelikeDeliverPanel } from "@/components/steps/LifelikeDeliverPanel";
import { QuoteView } from "@/components/steps/QuoteView";
import { detailRows } from "@/components/steps/RunDetails";
import type { Conversion, Project, PublicPricing, StepQuoteResponse } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { MOCK_CAMPAIGN, mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../fixtures/project.json";

import { makeTr } from "@/lib/i18n/t";

import { activeCampaign, campaignBadge, campaignCovers, campaignNote, offerLabel, offerUntil } from "./campaign";

vi.mock("@/components/steps/polling", () => ({ POLL_INTERVAL_MS: 30 }));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const PID = (projectFixture as { project_id: string }).project_id;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const ON = {
  active: true,
  pct: 0.25,
  percent: 25,
  max_preset: "qhd",
  presets: ["1080p", "qhd"],
  starts_at: "2026-11-07T00:00:00Z",
  ends_at: "2099-01-11T07:59:59Z",
  label: "Launch offer until Jan 10",
};

async function pricing(): Promise<PublicPricing> {
  return (await (await fetch(`${GATEWAY}/v1/pricing`)).json()) as PublicPricing;
}

describe("reading /v1/pricing campaign", () => {
  it("badges and the note follow the gateway's fields", () => {
    const p = { campaign: ON } as unknown as PublicPricing;
    expect(activeCampaign(p)?.label).toBe("Launch offer until Jan 10");
    expect(campaignCovers(p, "qhd")).toBe(true);
    expect(campaignCovers(p, "4k")).toBe(false);
    expect(campaignBadge(p, "1080p")).toBe("−25% launch offer");
    expect(campaignBadge(p, "4k")).toBeNull();
    expect(campaignNote(p)).toBe("Launch offer until Jan 10: −25% on 1080p and 1440p.");
  });

  it("the words are the web's, from the gateway's fields (owner 2026-11-07)", () => {
    const ja = makeTr("ja", { offer: { label: "ローンチ特典 −{pct}%", until: "{date}までのローンチ特典" } });
    expect(offerLabel(0.25, "Launch offer −25%")).toBe("Launch offer −25%");
    expect(offerLabel(0.25, "Launch offer −25%", ja)).toBe("ローンチ特典 −25%");
    // a row with only the gateway's label: its share, in the web's words
    expect(offerLabel(null, "Launch offer −25%", ja)).toBe("ローンチ特典 −25%");
    // nothing structured: the gateway's text as sent
    expect(offerLabel(null, "Special", ja)).toBe("Special");
    // the end of Jan 10, Pacific, reads Jan 10 everywhere
    expect(offerUntil("2027-01-11T07:59:59Z", "x")).toBe("Launch offer until Jan 10");
    expect(offerUntil("2027-01-11T07:59:59Z", "x", ja)).toBe("1月10日までのローンチ特典");
    expect(offerUntil(null, "Launch offer until Jan 10", ja)).toBe("Launch offer until Jan 10");
  });

  it("quiet when inactive, ended or absent", () => {
    expect(activeCampaign({ campaign: { active: false } } as unknown as PublicPricing)).toBeNull();
    const ended = { campaign: { ...ON, ends_at: "2026-01-01T00:00:00Z" } } as unknown as PublicPricing;
    expect(activeCampaign(ended)).toBeNull();
    expect(campaignBadge(ended, "1080p")).toBeNull();
    expect(campaignNote({} as PublicPricing)).toBeNull();
  });
});

describe("the quote line", () => {
  function quote(breakdown: Record<string, unknown>, amount: number): StepQuoteResponse {
    return {
      step: "production",
      method: "lifelike",
      params: { preset: "qhd", formats: ["mvhevc"] },
      quote: {
        amount_cents: amount,
        currency: "usd",
        breakdown: {
          step: "production",
          preset: "qhd",
          billable_seconds: 120,
          fps_factor: 1,
          list_cents_per_minute: 450,
          cents_per_minute: 450,
          list_base_cents: 900,
          subtotal_cents: 900,
          ...breakdown,
        },
      },
      reuse_stages: null,
    };
  }

  it("Launch offer −25% in the gateway's words, after the price", () => {
    render(
      <QuoteView
        result={quote({ campaign_cents: 225, campaign_label: "Launch offer −25%", campaign_pct: 0.25 }, 675)}
      />,
    );
    expect(screen.getByText("Launch offer −25%")).toBeTruthy();
    expect(screen.getByTestId("quote-campaign").textContent).toBe("−$2.25");
    // the offer isn't mistaken for the $1 minimum
    expect(document.body.textContent).not.toMatch(/minimum/i);
  });

  it("no line without campaign_cents", () => {
    render(<QuoteView result={quote({ campaign_cents: 0 }, 900)} />);
    expect(screen.queryByTestId("quote-campaign")).toBeNull();
  });
});

describe("Make 3D with the offer on (mock like TEST)", () => {
  function deliver(): Project {
    const p = mockDb.projects.get(PID)!;
    p.method = "lifelike";
    return structuredClone({ ...p, conversions: [] });
  }
  beforeEach(() => {
    mockDb.tierPricing = true;
    resetPricingCache();
  });
  afterEach(() => {
    act(() => clearStepQuotes());
    resetPricingCache();
  });

  it("1080p and 1440p carry the badge; 1440p's quote takes 25% off", async () => {
    mockDb.campaign = true;
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={deliver()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    expect((await screen.findByTestId("quality-offer-1080p")).textContent).toBe("−25% launch offer");
    expect(screen.getByTestId("quality-offer-qhd").textContent).toBe("−25% launch offer");
    expect(screen.queryByTestId("quality-offer-4k")).toBeNull();
    expect(document.body.textContent).toContain("Launch offer until Jan 10: −25% on 1080p and 1440p.");
    // 4K first (the source's size): no offer on its quote
    await screen.findByTestId("quote-base");
    expect(screen.queryByTestId("quote-campaign")).toBeNull();
    fireEvent.click(within(screen.getByTestId("quality-qhd")).getByRole("radio"));
    await waitFor(() => expect(screen.getByTestId("quote-campaign").textContent).toMatch(/^−\$\d+\.\d\d$/));
    expect(screen.getByText("Launch offer −25%")).toBeTruthy();
  });

  it("nothing while the offer is off", async () => {
    mockDb.campaign = false;
    render(
      <AuthProvider>
        <LifelikeDeliverPanel project={deliver()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    fireEvent.click(within(await screen.findByTestId("quality-qhd")).getByRole("radio"));
    await screen.findByTestId("quote-base");
    expect(screen.queryByTestId("quality-offer-qhd")).toBeNull();
    expect(screen.queryByTestId("quote-campaign")).toBeNull();
    expect(document.body.textContent).not.toMatch(/launch offer/i);
  });
});

describe("the price table: a badge, prices unchanged", () => {
  beforeEach(() => {
    mockDb.tierPricing = true;
  });

  it("badges 1080p and 1440p and says until when", async () => {
    mockDb.campaign = true;
    const p = await pricing();
    expect(p.campaign).toMatchObject({ active: true, percent: 25, presets: MOCK_CAMPAIGN.presets, label: MOCK_CAMPAIGN.label });
    render(<LifelikePrices pricing={p} />);
    expect(screen.getByTestId("offer-1080p").textContent).toBe("−25% launch offer");
    expect(screen.getByTestId("offer-qhd").textContent).toBe("−25% launch offer");
    expect(screen.queryByTestId("offer-4k")).toBeNull();
    expect(screen.getByTestId("pricing-offer").textContent).toBe("Launch offer until Jan 10: −25% on 1080p and 1440p.");
    // the list price, not a reduced one
    expect(screen.getByTestId("price-1080p").textContent).toContain("$4.00");
  });

  it("gone when /v1/pricing says inactive", async () => {
    mockDb.campaign = false;
    const p = await pricing();
    expect(p.campaign).toEqual({ active: false });
    render(<LifelikePrices pricing={p} />);
    expect(screen.queryByTestId("offer-1080p")).toBeNull();
    expect(screen.queryByTestId("pricing-offer")).toBeNull();
  });
});

describe("a run the offer covered", () => {
  it("Run details show the line", () => {
    const run: Conversion = {
      conversion_id: "conv00000offer",
      state: "succeeded",
      kind: "video",
      project_id: PID,
      step: "production",
      params: { preset: "1080p", formats: ["mvhevc"] },
      quote: {
        amount_cents: 675,
        currency: "usd",
        breakdown: { step: "production", preset: "1080p", campaign_cents: 225, campaign_label: "Launch offer −25%" },
      },
      campaign_cents: 225,
      progress: 1,
      created_at: "2026-11-07T09:00:00Z",
      updated_at: "2026-11-07T09:10:00Z",
    };
    const rows = detailRows(structuredClone(projectFixture) as unknown as Project, run);
    expect(rows.find((r) => r.label === "Launch offer")?.value).toBe("Launch offer −25% · −$2.25");
    const plain = detailRows(structuredClone(projectFixture) as unknown as Project, {
      ...run,
      campaign_cents: undefined,
      quote: { amount_cents: 900, currency: "usd", breakdown: { step: "production", campaign_cents: 0 } },
    });
    expect(plain.find((r) => r.label === "Launch offer")).toBeUndefined();
  });
});
