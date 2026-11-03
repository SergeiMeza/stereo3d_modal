import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { UserMenu } from "@/components/auth/UserMenu";
import type { Conversion } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { BillingScreen } from "./BillingScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/account/billing",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const PID = (projectFixture as { project_id: string }).project_id;

function run(id: string, cents: number, over: Partial<Conversion> = {}): Conversion {
  const c: Conversion = {
    conversion_id: id,
    state: "succeeded",
    kind: "video",
    project_id: PID,
    step: "production",
    method: "lifelike",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: { amount_cents: cents, currency: "usd" },
    progress: 1,
    outputs: ["mvhevc"],
    billing: { status: "charged", charged_cents: cents },
    created_at: "2026-11-02T10:00:00Z",
    updated_at: "2026-11-02T10:30:00Z",
    ...over,
  };
  mockDb.conversions.set(id, c);
  return c;
}

function renderBilling() {
  render(
    <AuthProvider>
      <BillingProvider>
        <BillingScreen />
      </BillingProvider>
    </AuthProvider>,
  );
}

describe("Billing (S3D-57, S3D-62)", () => {
  it("shows the card and one row per card charge, expandable to what it covered", async () => {
    run("cbig00000001", 4972, { charge_timing: "before", updated_at: "2026-11-03T09:00:00Z" });
    run("csmall000001", 100, { step: "lifelike_preview" });
    run("csmall000002", 675, { params: { preset: "1080p", formats: ["sbs"] } });
    run("crefund00001", 1838, {
      charge_timing: "before",
      state: "failed",
      billing: { status: "refunded", charged_cents: 1838 },
      updated_at: "2026-11-01T09:00:00Z",
    });
    renderBilling();

    // S3D-62: read-only, with the portal for changes
    const methods = await screen.findByTestId("payment-methods");
    expect(methods.textContent).toMatch(/^Visa •••• 4242Expires \d\d\/\d\dDefault$/);
    expect(screen.getByRole("button", { name: "Manage payment methods" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove|Make default|Add/ })).toBeNull();

    const rows = await screen.findAllByTestId(/^charge-ch_/);
    expect(rows).toHaveLength(3);
    // newest first: the big run alone, then the day's small runs together
    const [big, grouped, refunded] = rows;
    expect(within(big).getByTestId("charge-amount").textContent).toBe("$49.72");
    expect(within(big).getByTestId("charge-status").textContent).toBe("Paid");
    expect(big.textContent).toContain("Visa •••• 4242");
    expect(within(big).getByRole("link", { name: "Receipt" }).getAttribute("target")).toBe(
      "_blank",
    );
    expect(within(big).getByRole("link", { name: "Invoice" }).getAttribute("target")).toBe(
      "_blank",
    );
    expect(grouped.textContent).toContain("2 items");
    expect(within(grouped).getByTestId("charge-amount").textContent).toBe("$7.75");
    fireEvent.click(within(grouped).getByRole("button", { expanded: false }));
    const items = within(grouped).getByTestId("charge-items");
    expect(items.textContent).toContain("Preview · 4K");
    expect(items.textContent).toContain("3D video · 1080p");
    expect(within(refunded).getByTestId("charge-status").textContent).toBe("Refunded");
    expect(within(refunded).getByTestId("charge-amount").textContent).toBe("−$18.38");
    // no balance or limit wording (S3D-21)
    expect(document.body.textContent).not.toMatch(/balance|limit|pending/i);
  });

  it("is in the account menu", () => {
    render(
      <AuthProvider>
        <UserMenu />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = within(screen.getByTestId("account-menu"));
    expect(menu.getByRole("menuitem", { name: "Billing" }).getAttribute("href")).toBe(
      "/account/billing",
    );
    expect(menu.getByRole("menuitem", { name: "Account" })).toBeTruthy();
    expect(menu.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });
});

describe("payment method labels (S3D-60)", () => {
  it("names the type and the card or account", async () => {
    const { methodLabel } = await import("@/lib/api/usePaymentMethods");
    expect(
      methodLabel({ id: "a", type: "apple_pay", brand: "visa", last4: "4242", is_default: true }),
    ).toBe("Apple Pay · Visa •••• 4242");
    expect(
      methodLabel({ id: "b", type: "paypal", email: "name@example.com", is_default: false }),
    ).toBe("PayPal · name@…");
    expect(methodLabel({ id: "c", type: "alipay", is_default: false, pay_now: true })).toBe(
      "Alipay",
    );
  });
});
