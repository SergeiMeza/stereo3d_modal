/**
 * Owner 2026-11-07: while /v1/pricing says china_payments false (or
 * nothing), China mode says "Payments in mainland China are coming soon."
 * where it would pay — the run's pay sheet, the top-up, a plan checkout
 * and the hand-off page — and asks the gateway for no payment; a gateway
 * 403 china_payments_unavailable reads the same. Outside China mode the
 * flag changes nothing.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LifelikePreviewPanel } from "@/components/steps/LifelikePreviewPanel";
import type { PlanDef, Project } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { AddFundsSheet } from "./BalanceDialogs";
import { ChinaPaySheet } from "./ChinaPaySheet";
import { HandoffPage } from "./HandoffPage";
import { PlanSheet } from "./PlanSheet";

const china = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => china.value }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const PID = (projectFixture as { project_id: string }).project_id;
const SOON = "Payments in mainland China are coming soon.";
const COMING_SOON_403 = () =>
  HttpResponse.json(
    { error: "china_payments_unavailable", message: SOON },
    { status: 403 },
  );

beforeAll(() => {
  HTMLMediaElement.prototype.play = function play() {
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause() {};
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  china.value = true;
  resetPricingCache();
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  mockDb.reset();
});
afterAll(() => server.close());

/** Paths of the payment requests that went out. */
function paymentCalls(): string[] {
  const calls: string[] = [];
  server.events.on("request:start", ({ request }) => {
    const path = new URL(request.url).pathname;
    if (/pay-now|topup|\/v1\/billing\/plan|\/pay$/.test(path)) calls.push(`${request.method} ${path}`);
  });
  return calls;
}

const BUSINESS: PlanDef = {
  name: "Business",
  monthly_cents: 29900,
  credit_cents: 40000,
  max_active_runs: 3,
  free_previews_per_period: 50,
  express_included: true,
};

function project(): Project {
  const p = mockDb.projects.get(PID)!;
  p.method = "lifelike";
  return structuredClone({ ...p, conversions: [] });
}

describe("China mode with its payments off", () => {
  it("the run's pay sheet says it's coming soon, with no Alipay or WeChat Pay", async () => {
    mockDb.chinaPayments = false;
    mockDb.billing.methods = [{ id: "pm_wechat", type: "wechat_pay", is_default: true, pay_now: true }];
    render(
      <AuthProvider>
        <LifelikePreviewPanel project={project()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const main = (await screen.findByTestId("checkout-main")) as HTMLButtonElement;
    await waitFor(() => expect(main.disabled).toBe(false));
    fireEvent.click(main);
    const sheet = await screen.findByTestId("china-sheet");
    expect(within(sheet).getByTestId("china-coming-soon").textContent).toBe(SOON);
    expect(within(sheet).queryByTestId("china-alipay")).toBeNull();
    expect(within(sheet).queryByTestId("china-wechat")).toBeNull();
  });

  it("a gateway that refuses the run (403) says the same by the button", async () => {
    mockDb.chinaPayments = false;
    server.use(http.post(`${GATEWAY}/v1/projects/:id/conversions`, COMING_SOON_403));
    render(
      <AuthProvider>
        <LifelikePreviewPanel project={project()} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    const main = (await screen.findByTestId("checkout-main")) as HTMLButtonElement;
    await waitFor(() => expect(main.disabled).toBe(false));
    fireEvent.click(main);
    expect(await screen.findByText(SOON)).toBeTruthy();
  });

  it("the top-up says it's coming soon and asks for no payment", async () => {
    mockDb.chinaPayments = false;
    const calls = paymentCalls();
    render(
      <AuthProvider>
        <BillingProvider>
          <AddFundsSheet onClose={() => {}} />
        </BillingProvider>
      </AuthProvider>,
    );
    const sheet = await screen.findByTestId("add-funds-sheet");
    await waitFor(() => expect(within(sheet).getByTestId("china-coming-soon").textContent).toBe(SOON));
    expect(within(sheet).queryByRole("button", { name: "Alipay" })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a plan checkout says it's coming soon and asks for no checkout", async () => {
    mockDb.chinaPayments = false;
    const calls = paymentCalls();
    render(
      <AuthProvider>
        <BillingProvider>
          <PlanSheet plan="business" def={BUSINESS} onClose={() => {}} />
        </BillingProvider>
      </AuthProvider>,
    );
    expect((await screen.findByTestId("plan-error")).textContent).toBe(SOON);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it("the hand-off page's Alipay and WeChat Pay say it's coming soon", async () => {
    mockDb.chinaPayments = false;
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
        <HandoffPage code="ABCD-EFGH" />
      </AuthProvider>,
    );
    await screen.findByTestId("handoff-amount");
    expect((await screen.findByTestId("china-coming-soon")).textContent).toBe(SOON);
    expect(screen.queryByRole("button", { name: "Alipay" })).toBeNull();
  });
});

describe("China payments on, but the gateway still refuses (403)", () => {
  it("the China pay sheet shows the line instead of an error", async () => {
    mockDb.chinaPayments = true;
    server.use(http.post(`${GATEWAY}/v1/conversions/:id/pay-now`, COMING_SOON_403));
    render(
      <AuthProvider>
        <ChinaPaySheet conversionId="cchina000001" amountCents={4972} subtitle="3D video" onClose={() => {}} />
      </AuthProvider>,
    );
    fireEvent.click(await screen.findByTestId("china-alipay"));
    expect((await screen.findByTestId("china-coming-soon")).textContent).toBe(SOON);
    expect(screen.queryByTestId("pay-unavailable")).toBeNull();
  });

  it("a plan checkout shows the line", async () => {
    mockDb.chinaPayments = true;
    server.use(http.post(`${GATEWAY}/v1/billing/plan`, COMING_SOON_403));
    render(
      <AuthProvider>
        <BillingProvider>
          <PlanSheet plan="business" def={BUSINESS} onClose={() => {}} />
        </BillingProvider>
      </AuthProvider>,
    );
    expect((await screen.findByTestId("plan-error")).textContent).toBe(SOON);
  });
});

describe("outside China mode", () => {
  it("the flag changes nothing: the plan checkout opens", async () => {
    china.value = false;
    mockDb.chinaPayments = false;
    render(
      <AuthProvider>
        <BillingProvider>
          <PlanSheet plan="business" def={BUSINESS} onClose={() => {}} />
        </BillingProvider>
      </AuthProvider>,
    );
    expect(await screen.findByTestId("plan-main")).toBeTruthy();
    expect(screen.queryByTestId("china-coming-soon")).toBeNull();
    expect(screen.queryByText(SOON)).toBeNull();
  });
});
