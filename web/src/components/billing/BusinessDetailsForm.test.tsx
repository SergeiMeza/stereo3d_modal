/**
 * Account → Business details (owner 2026-11-04): prefilled from GET
 * /v1/billing/company (Checkout fills it), saved with PUT, Stripe's tax ID
 * message on a 400.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { BusinessDetailsForm, SAVED_LINE } from "./BusinessDetailsForm";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/account/business-details",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const renderForm = () =>
  render(
    <AuthProvider>
      <BusinessDetailsForm />
    </AuthProvider>,
  );

describe("business details", () => {
  it("prefills from Checkout, saves, and says the next invoices use it", async () => {
    mockDb.billing.company = {
      company_name: "Northlight Films",
      address: {
        country: "GB",
        line1: "1 King St",
        city: "London",
        postal_code: "EC2V 8AU",
      },
      tax_id: { type: "gb_vat", value: "GB123456789" },
    };
    renderForm();
    expect(
      ((await screen.findByLabelText("Company name")) as HTMLInputElement)
        .value,
    ).toBe("Northlight Films");
    expect((screen.getByLabelText("Country") as HTMLSelectElement).value).toBe(
      "GB",
    );
    expect((screen.getByLabelText("Number") as HTMLInputElement).value).toBe(
      "GB123456789",
    );
    fireEvent.change(
      screen.getByLabelText("Billing email for invoice copies"),
      { target: { value: "accounts@northlight.example" } },
    );
    fireEvent.change(
      screen.getByLabelText("Purchase order reference (optional)"),
      { target: { value: "PO-2211" } },
    );
    fireEvent.click(screen.getByTestId("company-save"));
    expect((await screen.findByTestId("company-saved")).textContent).toBe(
      SAVED_LINE,
    );
    expect(SAVED_LINE).toBe(
      "Saved. Your next invoices will use these details.",
    );
    expect(mockDb.billing.company).toMatchObject({
      company_name: "Northlight Films",
      billing_email: "accounts@northlight.example",
      po_reference: "PO-2211",
      address: {
        country: "GB",
        line1: "1 King St",
        city: "London",
        postal_code: "EC2V 8AU",
      },
      tax_id: { type: "gb_vat", value: "GB123456789" },
    });
  });

  it("shows Stripe's tax ID message on a 400 and keeps what was typed", async () => {
    renderForm();
    fireEvent.change(await screen.findByLabelText("Country"), {
      target: { value: "GB" },
    });
    fireEvent.change(screen.getByLabelText("Company name"), {
      target: { value: "Kyoto Films Ltd" },
    });
    fireEvent.change(screen.getByLabelText("Number"), {
      target: { value: "GB12" },
    });
    fireEvent.click(screen.getByTestId("company-save"));
    await waitFor(() =>
      expect(screen.getByTestId("company-tax-error").textContent).toBe(
        "Invalid value for gb_vat: GB12. Check the number and its country.",
      ),
    );
    expect(
      (screen.getByLabelText("Company name") as HTMLInputElement).value,
    ).toBe("Kyoto Films Ltd");
    expect(screen.queryByTestId("company-saved")).toBeNull();
  });
});
