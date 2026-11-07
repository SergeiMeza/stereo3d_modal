/**
 * Owner 2026-11-07 (Option B, Stripe Adaptive Pricing): checkout offers
 * the customer's local currency while GET /v1/pricing says
 * adaptive_pricing. Then the checkout sheets and the quote say "You'll see
 * your local price at checkout."; with it off or missing they say
 * "Charged in US dollars." as before. The hand-off page follows it on the
 * card path; Alipay and WeChat Pay stay in US dollars.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { QuoteView } from "@/components/steps/QuoteView";
import type { Conversion, StepQuoteResponse } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { HandoffPage } from "./HandoffPage";
import { PaySheet } from "./PaySheet";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const LOCAL = "You'll see your local price at checkout.";
const USD = "Charged in US dollars.";
const IN_SHEET = (usd: string) => `The payment form shows the price in your currency. Base price ${usd}.`;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => resetPricingCache());
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function run(): Conversion {
  const c: Conversion = {
    conversion_id: "clocal000001",
    state: "created",
    kind: "video",
    project_id: "a1b2c3d4e5f6",
    step: "production",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: { amount_cents: 4972, currency: "usd" },
    progress: 0,
    billing: {
      status: "requires_payment",
      reason: "no_method",
      checkout: { client_secret: "cs_mock_local_secret", expires_at: new Date(Date.now() + 20 * 60_000).toISOString() },
    },
    created_at: "2026-11-07T00:00:00Z",
    updated_at: "2026-11-07T00:00:00Z",
  };
  mockDb.conversions.set(c.conversion_id, c);
  return c;
}

function paySheet(): void {
  const c = run();
  render(
    <AuthProvider>
      <PaySheet conversionId={c.conversion_id} amountCents={4972} action="Make 3D" billing={c.billing} run={c} onClose={() => {}} />
    </AuthProvider>,
  );
}

const quote: StepQuoteResponse = {
  step: "production",
  params: { preset: "4k", formats: ["mvhevc"] },
  quote: { amount_cents: 4972, currency: "usd" },
};

describe("the pay sheet's currency line follows adaptive_pricing", () => {
  it("off (prod at launch): \"Charged in US dollars.\"", async () => {
    mockDb.adaptivePricing = false;
    paySheet();
    const lines = await screen.findByTestId("pay-lines");
    // after /v1/pricing has answered
    await new Promise((r) => setTimeout(r, 50));
    expect(lines.textContent).toContain(USD);
    expect(lines.textContent).not.toContain(LOCAL);
  });

  it("on: the open sheet says the payment form shows the local price, with the base price (QA 2026-11-07)", async () => {
    mockDb.adaptivePricing = true;
    paySheet();
    const lines = await screen.findByTestId("pay-lines");
    await waitFor(() => expect(lines.textContent).toContain(IN_SHEET("US$49.72")));
    expect(lines.textContent).not.toContain(USD);
    // the quote's "You'll see…" line is for before the sheet opens
    expect(lines.textContent).not.toContain(LOCAL);
  });

  it("missing from /v1/pricing counts as off", async () => {
    server.use(
      http.get(`${GATEWAY}/v1/pricing`, () => HttpResponse.json({ currency: "usd", methods: {} })),
    );
    paySheet();
    const lines = await screen.findByTestId("pay-lines");
    // after /v1/pricing has answered
    await new Promise((r) => setTimeout(r, 50));
    expect(lines.textContent).toContain(USD);
  });
});

describe("the quote's note under the USD total", () => {
  it("shows with adaptive_pricing on, the total staying in US dollars", async () => {
    mockDb.adaptivePricing = true;
    render(<QuoteView result={quote} />);
    expect((await screen.findByTestId("quote-local-note")).textContent).toBe(LOCAL);
    expect(screen.getByTestId("quote-total").textContent).toBe("$49.72");
  });

  it("isn't there with it off, nor on a free quote", async () => {
    mockDb.adaptivePricing = false;
    render(<QuoteView result={quote} />);
    await screen.findByTestId("quote-total");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("quote-local-note")).toBeNull();
    cleanup();
    resetPricingCache();
    mockDb.adaptivePricing = true;
    render(<QuoteView result={{ ...quote, quote: { amount_cents: 0, currency: "usd" } }} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("quote-local-note")).toBeNull();
  });
});

describe("the hand-off page", () => {
  async function openCode(): Promise<string> {
    const c = run();
    const res = await fetch(`${GATEWAY}/v1/conversions/${c.conversion_id}/handoff`, { method: "POST", body: "{}" });
    const { code } = (await res.json()) as { code: string };
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  it("the card path follows adaptive_pricing", async () => {
    mockDb.adaptivePricing = true;
    const code = await openCode();
    render(
      <AuthProvider>
        <HandoffPage code={code} />
      </AuthProvider>,
    );
    await screen.findByTestId("handoff-amount");
    expect(await screen.findByText(LOCAL)).toBeTruthy();
    expect(screen.queryByText(USD)).toBeNull();
  });

  it("Alipay and WeChat Pay stay in US dollars", async () => {
    mockDb.adaptivePricing = true;
    const code = await openCode();
    server.use(
      http.get(`${GATEWAY}/v1/handoff/:code`, () =>
        HttpResponse.json({
          label: "3D video · 4K",
          amount_cents: 4972,
          currency: "usd",
          china: true,
          expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
          state: "open",
        }),
      ),
    );
    render(
      <AuthProvider>
        <HandoffPage code={code} />
      </AuthProvider>,
    );
    await screen.findByTestId("handoff-amount");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(USD)).toBeTruthy();
    expect(screen.queryByText(LOCAL)).toBeNull();
  });
});
