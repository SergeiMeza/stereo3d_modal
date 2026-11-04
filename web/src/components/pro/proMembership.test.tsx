/**
 * QA 2026-11-05: a Pro member's /pro says where the Pro comes from, its
 * period, its renewal or end date when known, and where to manage it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ProScreen } from "@/components/pro/ProScreen";
import type { AccountPlan } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { resetProForTests } from "@/lib/pro/usePro";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { periodWord, PRO_UNKNOWN_LINE, proMembership } from "./proMembership";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/pro",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetProForTests();
  mockDb.reset();
});
afterAll(() => server.close());

const webPlan: AccountPlan = {
  plan: "pro",
  plan_id: "pro_monthly",
  status: "active",
  active: true,
  cancel_at_period_end: false,
  current_period_end: "2026-12-05T00:00:00Z",
};

describe("the Pro member's line", () => {
  it("web Pro: period, renewal (or end) date, Manage in Billing", () => {
    expect(proMembership({ pro: true, known: true, source: "stripe" }, webPlan)).toEqual({
      text: "Pro Monthly on the web. Renews on 5 Dec 2026.",
      manage: "billing",
    });
    expect(
      proMembership({ pro: true, known: true, source: "rc_billing" }, { ...webPlan, cancel_at_period_end: true })?.text,
    ).toBe("Pro Monthly on the web. Ends on 5 Dec 2026.");
  });

  it("App Store Pro: the period from the product, managed in the Apple ID settings", () => {
    expect(proMembership({ pro: true, known: true, source: "app_store", via: "pro_subs_1y_v1" }, null)).toEqual({
      text: "Pro Yearly through the App Store.",
      manage: "apple",
    });
    expect(proMembership({ pro: true, known: true, source: "mac_app_store" }, null)?.text).toBe(
      "Pro through the Mac App Store.",
    );
  });

  it("a grant: nothing to manage", () => {
    expect(proMembership({ pro: true, known: true, source: "promotional" }, null)).toEqual({
      text: "Pro given to your account by Spatial Video Studio, at no charge.",
      manage: null,
    });
  });

  it("the gateway's source, period and dates (QA batch 3)", () => {
    expect(
      proMembership({ pro: true, known: true, source: "web", period: "year", renews_at: "2027-01-10T00:00:00Z" }, null),
    ).toEqual({ text: "Pro Yearly on the web. Renews on 10 Jan 2027.", manage: "billing" });
    expect(
      proMembership(
        { pro: true, known: true, source: "app_store", period: "month", renews_at: "2026-12-01T00:00:00Z" },
        null,
      ),
    ).toEqual({ text: "Pro Monthly through the App Store. Renews on 1 Dec 2026.", manage: "apple" });
    expect(
      proMembership({ pro: true, known: true, source: "app_store", period: "month", ends_at: "2026-12-01T00:00:00Z" }, null)
        ?.text,
    ).toBe("Pro Monthly through the App Store. Ends on 1 Dec 2026.");
    expect(proMembership({ pro: true, known: true, source: "grant", ends_at: "2027-02-01T00:00:00Z" }, null)).toEqual({
      text: "Pro given to your account by Spatial Video Studio, at no charge. Ends on 1 Feb 2027.",
      manage: null,
    });
  });

  it("an unknown or missing source: a generic line, nothing to manage", () => {
    expect(proMembership({ pro: true, known: true, source: "unknown" }, null)).toEqual({
      text: PRO_UNKNOWN_LINE,
      manage: null,
    });
    expect(proMembership({ pro: true, known: true }, null)).toEqual({ text: PRO_UNKNOWN_LINE, manage: null });
    expect(PRO_UNKNOWN_LINE).toBe("Pro is active. Manage it where you bought it.");
  });

  it("nothing for a plan's Pro, a simulated one, or no Pro", () => {
    expect(proMembership({ pro: true, known: true, source: "plan", plan_id: "business" }, null)).toBeNull();
    expect(proMembership({ pro: true, known: true, source: "simulated" }, null)).toBeNull();
    expect(proMembership({ pro: false, known: true }, null)).toBeNull();
    expect(periodWord("pro_weekly")).toBe("Weekly");
    expect(periodWord("pro_subs_1m_v2")).toBe("Monthly");
    expect(periodWord("pass_3m")).toBeNull();
  });

  it("shows on /pro with the Apple link for an App Store Pro", async () => {
    mockDb.proStatus = {
      pro: true,
      known: true,
      source: "app_store",
      via: "pro_subs_1y_v1",
      management_url: "https://apps.apple.com/account/subscriptions",
    };
    (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
    render(
      <AuthProvider>
        <BillingProvider>
          <ProScreen />
        </BillingProvider>
      </AuthProvider>,
    );
    const line = await screen.findByTestId("pro-membership", undefined, { timeout: 5000 });
    expect(line.textContent).toContain("Pro Yearly through the App Store.");
    const link = screen.getByRole("link", { name: "Manage in your Apple ID settings" });
    expect(link.getAttribute("href")).toBe("https://apps.apple.com/account/subscriptions");
  });
});
