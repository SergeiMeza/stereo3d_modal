/**
 * Screens in other languages for a browser look (owner 2026-11-07): with
 * SCREENS_SNAPSHOT_DIR set, writes each screen's HTML (ar: quote, Make 3D,
 * Classic Make 3D, Run details, Billing history, Pricing; ja and de: Make
 * 3D and Pricing) for screenshots; without it the suite is skipped.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import type { ReactNode } from "react";

import { BillingScreen } from "@/components/billing/BillingScreen";
import { PricingScreen } from "@/components/pricing/PricingScreen";
import { clearStepQuotes } from "@/components/steps/checkoutStore";
import { DeliverPanel } from "@/components/steps/DeliverPanel";
import { HistoryList } from "@/components/steps/HistoryList";
import { LifelikeDeliverPanel } from "@/components/steps/LifelikeDeliverPanel";
import { QuoteView } from "@/components/steps/QuoteView";
import type { Conversion, Project, StepQuoteResponse } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { messagesFor } from "./catalogs";
import { I18nProvider } from "./I18nProvider";
import { dirOf, type Locale } from "./locales";

vi.mock("@/components/steps/polling", () => ({ POLL_INTERVAL_MS: 40 }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pricing",
}));

const DIR = process.env.SCREENS_SNAPSHOT_DIR;
const PID = (projectFixture as { project_id: string }).project_id;

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  act(() => clearStepQuotes());
  resetPricingCache();
  mockDb.reset();
});
afterAll(() => server.close());

function show(locale: Locale, node: ReactNode) {
  document.documentElement.lang = locale;
  document.documentElement.dir = dirOf(locale);
  return render(
    <I18nProvider locale={locale} messages={messagesFor(locale)}>
      <div dir={dirOf(locale)}>{node}</div>
    </I18nProvider>,
  );
}

function save(name: string, locale: Locale, root: HTMLElement): void {
  mkdirSync(DIR!, { recursive: true });
  writeFileSync(
    join(DIR!, `${locale}-${name}.html`),
    `<html lang="${locale}" dir="${dirOf(locale)}"><body class="bg-surface-0 text-fg text-sm">${root.innerHTML}</body></html>`,
  );
}

function lifelikeProject(): Project {
  mockDb.tierPricing = true;
  mockDb.campaign = true;
  const p = mockDb.projects.get(PID)!;
  p.method = "lifelike";
  return structuredClone({ ...p, conversions: [] }) as Project;
}

function run(): Conversion {
  const c = {
    conversion_id: "snap_run_1",
    state: "succeeded",
    kind: "video",
    project_id: PID,
    step: "production",
    method: "lifelike",
    params: { preset: "1080p", formats: ["mvhevc", "sbs"], from_frame: 24, to_frame: 144 },
    quote: { amount_cents: 1200, currency: "usd", breakdown: { step: "production", campaign_cents: 400, campaign_label: "Launch offer −25%" } },
    campaign_cents: 400,
    billing: { status: "charged", charged_cents: 1200 },
    charge_timing: "before",
    progress: 1,
    outputs: ["mvhevc", "sbs"],
    quality: "high",
    started_at: "2026-11-07T09:02:00Z",
    intro: false,
    created_at: "2026-11-07T09:00:00Z",
    updated_at: "2026-11-07T09:12:00Z",
  } as Conversion;
  mockDb.conversions.set(c.conversion_id, structuredClone(c));
  return c;
}

describe.skipIf(!DIR)("screens for a browser look", () => {
  const quote: StepQuoteResponse = {
    step: "production",
    method: "lifelike",
    params: { preset: "qhd", formats: ["mvhevc"] },
    quote: {
      amount_cents: 675,
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
        campaign_cents: 225,
        campaign_label: "Launch offer −25%",
      },
    },
    reuse_stages: null,
  };

  it("ar: the quote", () => {
    const { container } = show("ar", <QuoteView result={quote} />);
    save("quote", "ar", container);
  });

  for (const locale of ["ar", "ja", "de"] as const) {
    it(`${locale}: Make 3D (Lifelike)`, async () => {
      const { container } = show(
        locale,
        <AuthProvider>
          <LifelikeDeliverPanel project={lifelikeProject()} onProjectChanged={() => {}} />
        </AuthProvider>,
      );
      await screen.findByTestId("quote-breakdown", {}, { timeout: 4000 });
      fireEvent.click(within(screen.getByTestId("quality-qhd")).getByRole("radio"));
      await screen.findByTestId("quote-campaign", {}, { timeout: 4000 });
      save("make3d", locale, container);
    });

    it(`${locale}: Pricing`, async () => {
      mockDb.tierPricing = true;
      mockDb.campaign = true;
      const { container } = show(
        locale,
        <AuthProvider>
          <PricingScreen />
        </AuthProvider>,
      );
      await screen.findByTestId("pricing-lifelike", {}, { timeout: 4000 });
      save("pricing", locale, container);
    });
  }

  it("ar: Classic Make 3D (Deliver)", async () => {
    const p = mockDb.projects.get(PID)!;
    p.method = undefined;
    const project = structuredClone({ ...p, conversions: [] }) as Project;
    const { container } = show(
      "ar",
      <AuthProvider>
        <DeliverPanel project={project} onProjectChanged={() => {}} />
      </AuthProvider>,
    );
    await screen.findByTestId("quote-breakdown", {}, { timeout: 4000 });
    save("deliver", "ar", container);
  });

  it("ar: Run details", () => {
    const c = run();
    const project = { ...(structuredClone(projectFixture) as unknown as Project), method: "lifelike", conversions: [c] } as Project;
    const { container } = show(
      "ar",
      <AuthProvider>
        <BillingProvider>
          <HistoryList project={project} />
        </BillingProvider>
      </AuthProvider>,
    );
    fireEvent.click(within(screen.getByTestId("history-snap_run_1")).getByTestId("run-details-toggle"));
    save("run-details", "ar", container);
  });

  it("ar: Billing history", async () => {
    run();
    const { container } = show(
      "ar",
      <AuthProvider>
        <BillingProvider>
          <BillingScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    await screen.findByTestId("row-ch_snap_run_1", {}, { timeout: 4000 });
    save("billing", "ar", container);
  });
});
