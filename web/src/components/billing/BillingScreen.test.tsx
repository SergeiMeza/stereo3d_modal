import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** Radix menus open from the keyboard in jsdom (no pointer events). */
function openMenu(trigger: HTMLElement): void {
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("Billing (S3D-57, S3D-62)", () => {
  it("methods with Default and the order line; one row per charge, refunds with a credit note (P10)", async () => {
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

    const methods = await screen.findByTestId("payment-methods");
    expect(within(methods).getAllByRole("listitem")).toHaveLength(1);
    expect(methods.textContent).toContain("Visa •••• 4242");
    expect(methods.textContent).toContain("· Default");
    expect(screen.getByRole("button", { name: "Add payment method" })).toBeTruthy();
    expect(
      screen.getByText("We charge your default payment method. If it's declined, we try your others in this order."),
    ).toBeTruthy();
    // no portal on the web any more (spec v6.2)
    expect(screen.queryByRole("button", { name: /Manage payment methods/ })).toBeNull();

    const history = await screen.findByTestId("history");
    const rows = within(history).getAllByRole("listitem").filter((li) => li.dataset.testid?.startsWith("row-"));
    // newest first: the big run alone, the day's small runs together, the
    // refunded run's charge and its refund
    expect(rows).toHaveLength(4);
    const [big, grouped, refundedCharge, refund] = rows;
    expect(within(big).getByTestId("row-amount").textContent).toBe("$49.72");
    expect(within(big).getByTestId("row-status").textContent).toBe("Paid");
    expect(big.textContent).toContain("Visa •••• 4242");
    expect(within(big).getByRole("link", { name: "Receipt ↗" }).getAttribute("target")).toBe("_blank");
    expect(within(big).getByRole("link", { name: "Invoice ↗" })).toBeTruthy();
    expect(grouped.textContent).toContain("2 items · $7.75");
    fireEvent.click(within(grouped).getByRole("button", { name: /2 items/ }));
    const items = within(grouped).getByTestId("row-items");
    expect(items.textContent).toContain("Preview · 4K");
    expect(items.textContent).toContain("3D video · 1080p");
    expect(within(refundedCharge).getByTestId("row-status").textContent).toBe("Paid");
    expect(within(refund).getByTestId("row-amount").textContent).toBe("−$18.38");
    expect(within(refund).getByTestId("row-status").textContent).toBe("Refunded");
    expect(within(refund).getByRole("link", { name: "Credit note ↗" })).toBeTruthy();
    // Get help with this payment: a mail with the date, amount and reference
    fireEvent.click(within(big).getByRole("button", { name: "More" }));
    const help = within(big).getByTestId("row-help");
    expect(decodeURIComponent(help.getAttribute("href")!)).toMatch(/subject=Payment .+ · \$49\.72 · \w+$/);
    expect(screen.getByText("US dollars.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/pending/i);
  });

  it("while the account owes: a Payment needed row with Pay $X (P10)", async () => {
    mockDb.billing.unpaid.push({ conversion_id: "cowed0000001", amount_cents: 725, currency: "usd", needs_action: false });
    renderBilling();
    const row = await screen.findByTestId("row-row_outstanding");
    expect(within(row).getByTestId("row-status").textContent).toBe("Payment needed");
    expect(within(row).getByRole("button", { name: "Pay $7.25" })).toBeTruthy();
  });

  it("nothing yet: no saved methods and no purchases", async () => {
    mockDb.billing.hasPaymentMethod = false;
    mockDb.billing.card = undefined;
    mockDb.billing.methods = [];
    renderBilling();
    expect(await screen.findByText("No saved payment methods.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add payment method" })).toBeTruthy();
    expect(await screen.findByText("No purchases yet.")).toBeTruthy();
  });

  it("manage methods: make default, move, remove with confirm; the last one can't go while owing (P10)", async () => {
    mockDb.billing.methods.push({ id: "pm_mc", type: "card", brand: "mastercard", last4: "5454", exp_month: 1, exp_year: 2020, is_default: false });
    renderBilling();
    const list = await screen.findByTestId("payment-methods");
    expect(within(list).getByTestId("method-expired")).toBeTruthy();
    openMenu(screen.getByRole("button", { name: "Options for Mastercard •••• 5454" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Make default" }));
    await waitFor(() => expect(mockDb.billing.methods[0].id).toBe("pm_mc"));
    await waitFor(() =>
      expect(within(screen.getByTestId("payment-methods")).getAllByRole("listitem")[0].textContent).toMatch(
        /Mastercard •••• 5454.*· Default/,
      ),
    );
    openMenu(screen.getByRole("button", { name: "Options for Visa •••• 4242" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    await waitFor(() => expect(mockDb.billing.methods[0].id).toBe("pm_mock_4242"));
    // remove asks first
    openMenu(await screen.findByRole("button", { name: "Options for Mastercard •••• 5454" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByTestId("remove-confirm");
    expect(within(dialog).getByText("Remove Mastercard •••• 5454?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mockDb.billing.methods).toHaveLength(1));
  });

  it("the only method can't be removed while a payment is pending (P10)", async () => {
    mockDb.billing.unpaid.push({ conversion_id: "cowed0000001", amount_cents: 725, currency: "usd", needs_action: false });
    renderBilling();
    openMenu(await screen.findByRole("button", { name: "Options for Visa •••• 4242" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect((await screen.findByTestId("remove-blocked")).textContent).toBe(
      "You can't remove your only payment method while a payment is pending. Pay it or add another one first.",
    );
    expect(mockDb.billing.methods).toHaveLength(1);
  });

  it("Add payment method opens P15; saving adds the row; at 5 the button stops (P15)", async () => {
    renderBilling();
    fireEvent.click(await screen.findByTestId("add-method"));
    const save = await screen.findByTestId("add-method-save");
    const sheet = screen.getByTestId("add-method-sheet");
    expect(within(sheet).getByRole("heading").textContent).toBe("Add a payment method");
    expect(within(sheet).getByText("or add another way")).toBeTruthy();
    expect(within(sheet).getByLabelText("Make this my default")).toBeTruthy();
    expect(save.textContent).toBe("Save payment method");
    mockDb.billing.nextSetup = "declined";
    fireEvent.click(save);
    expect((await screen.findByTestId("add-method-error")).textContent).toBe(
      "We couldn't save this payment method. Try another one.",
    );
    fireEvent.click(screen.getByTestId("add-method-save"));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("add-method-sheet")).toBeNull(), { timeout: 3000 });
    await waitFor(() => expect(within(screen.getByTestId("payment-methods")).getAllByRole("listitem")).toHaveLength(2));
    for (let i = 0; i < 3; i++) {
      mockDb.billing.methods.push({ id: `pm_x${i}`, type: "card", brand: "visa", last4: `000${i}`, is_default: false });
    }
    cleanup();
    renderBilling();
    await screen.findByTestId("payment-methods");
    expect((screen.getByTestId("add-method") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("You can save up to 5 payment methods.")).toBeTruthy();
  });

  it("business details: the summary, and Edit opens Account → Business details", async () => {
    renderBilling();
    expect(await screen.findByText("No business details. Add them to show on invoices.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit" }).getAttribute("href")).toBe("/account/business-details");
    cleanup();
    mockDb.billing.company = {
      company_name: "Kyoto Films Ltd",
      address: { country: "GB", city: "London" },
      tax_id: { type: "gb_vat", value: "GB123456789" },
    };
    renderBilling();
    await waitFor(() =>
      expect(screen.getByTestId("company-summary").textContent).toBe("Kyoto Films Ltd · GB123456789 · London, United Kingdom"),
    );
  });

  it("Invoices tab: number, amount, PDF and credit notes under their invoice", async () => {
    run("cbig00000001", 4972, { charge_timing: "before" });
    run("crefund00001", 1838, { charge_timing: "before", state: "failed", billing: { status: "refunded", charged_cents: 1838 } });
    renderBilling();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Invoices" }));
    const list = await screen.findByTestId("invoices");
    expect(list.textContent).toMatch(/S3D-\d{4}/);
    expect(within(list).getAllByRole("link", { name: "PDF ↗" }).length).toBeGreaterThanOrEqual(3);
    expect(list.textContent).toContain("Credit note");
  });

  it("is in the account menu", () => {
    render(
      <AuthProvider>
        <UserMenu />
      </AuthProvider>,
    );
    openMenu(screen.getByRole("button", { name: "Account menu" }));
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
    ).toBe("PayPal · n•••@example.com");
    expect(methodLabel({ id: "c", type: "alipay", is_default: false, pay_now: true })).toBe(
      "Alipay",
    );
  });
});
