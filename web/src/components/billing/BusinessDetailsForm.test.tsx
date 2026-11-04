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
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { http, HttpResponse } from "msw";

import { AuthProvider } from "@/lib/auth";
import { COUNTRY_CODES, companySummary, countryName, taxTypesFor } from "@/lib/company";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { BusinessDetailsForm, SAVED_LINE } from "./BusinessDetailsForm";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/account/business-details",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
let geoCountry: string | null = null;
beforeEach(() => {
  geoCountry = null;
  // the page's own /api/geo (Vercel's country header)
  server.use(http.get("*/api/geo", () => HttpResponse.json({ country: geoCountry, requires_consent: false })));
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

/** Open the country picker, search, and pick the country. */
async function pickCountry(code: string, search?: string) {
  fireEvent.click(await screen.findByLabelText("Country"));
  if (search !== undefined) {
    fireEvent.change(screen.getByLabelText("Search countries"), {
      target: { value: search },
    });
  }
  fireEvent.click(await screen.findByTestId(`country-${code}`));
}

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
    expect(screen.getByLabelText("Country").textContent).toBe(
      "United Kingdom",
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
    await pickCountry("GB");
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

  it("saves and shows a country outside the old short list (Vietnam), with its tax ID type", async () => {
    renderForm();
    await pickCountry("VN", "Viet");
    expect(screen.getByLabelText("Country").textContent).toBe("Vietnam");
    // one type: no type select, the field says which number
    expect(screen.queryByLabelText("Type")).toBeNull();
    fireEvent.change(screen.getByLabelText("Vietnamese tax ID number"), {
      target: { value: "0101234567" },
    });
    fireEvent.change(screen.getByLabelText("City"), {
      target: { value: "Hanoi" },
    });
    fireEvent.click(screen.getByTestId("company-save"));
    expect(await screen.findByTestId("company-saved")).toBeTruthy();
    expect(mockDb.billing.company).toMatchObject({
      address: { country: "VN", city: "Hanoi" },
      tax_id: { type: "vn_tin", value: "0101234567" },
    });
    expect(screen.getByLabelText("Country").textContent).toBe("Vietnam");
  });

  it("finds a country by its code, and Nigeria and Argentina save too", async () => {
    renderForm();
    await pickCountry("NG", "ng");
    expect(screen.getByLabelText("Country").textContent).toBe("Nigeria");
    fireEvent.click(screen.getByTestId("company-save"));
    await waitFor(() => expect(mockDb.billing.company?.address?.country).toBe("NG"));
    fireEvent.click(screen.getByLabelText("Country"));
    fireEvent.change(screen.getByLabelText("Search countries"), { target: { value: "Argen" } });
    expect(screen.queryByTestId("country-US")).toBeNull();
    fireEvent.click(await screen.findByTestId("country-AR"));
    expect(screen.getByLabelText("Argentine CUIT")).toBeTruthy();
    fireEvent.click(screen.getByTestId("company-save"));
    await waitFor(() => expect(mockDb.billing.company?.address?.country).toBe("AR"));
  });

  it("India shows the GST number; Brazil asks which number", async () => {
    renderForm();
    await pickCountry("IN", "India");
    expect(screen.getByLabelText("Indian GST number")).toBeTruthy();
    expect(screen.queryByLabelText("Type")).toBeNull();
    await pickCountry("BR", "Bra");
    const type = screen.getByLabelText("Type") as HTMLSelectElement;
    expect([...type.options].map((o) => o.textContent)).toEqual([
      "Brazilian company number (CNPJ)",
      "Brazilian personal tax number (CPF)",
    ]);
  });

  it("Kosovo can be picked and saved", async () => {
    renderForm();
    await pickCountry("XK", "Kosovo");
    expect(screen.getByLabelText("Country").textContent).toBe("Kosovo");
    fireEvent.click(screen.getByTestId("company-save"));
    await waitFor(() => expect(mockDb.billing.company?.address?.country).toBe("XK"));
  });

  it("a country without a tax ID type hides the tax field", async () => {
    renderForm();
    await pickCountry("AF", "Afgh");
    expect(screen.getByText("No tax ID is needed for this country.")).toBeTruthy();
    expect(screen.queryByLabelText("Number")).toBeNull();
  });

  it("puts the visitor's own country first", async () => {
    geoCountry = "JP";
    renderForm();
    fireEvent.click(await screen.findByLabelText("Country"));
    await waitFor(() =>
      expect(screen.getByText("Your country").parentElement?.textContent).toContain("Japan"),
    );
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("Japan");
    expect(options.filter((o) => o.textContent?.includes("Japan"))).toHaveLength(1);
  });
});

describe("countries and tax IDs worldwide", () => {
  it("names any stored code with Intl, and the summary uses it", () => {
    expect(countryName("VN", "en")).toBe("Vietnam");
    expect(countryName("NG", "en")).toBe("Nigeria");
    expect(countryName("DE", "de")).toBe("Deutschland");
    expect(
      companySummary(
        { company_name: "Lumen SA", address: { country: "AR", city: "Buenos Aires" }, tax_id: { type: "ar_cuit", value: "30-12345678-9" } },
        "en",
      ),
    ).toBe("Lumen SA · 30-12345678-9 · Buenos Aires, Argentina");
  });

  it("offers Kosovo (XK) as Stripe does, and not CU, IR, KP or SY", () => {
    expect(COUNTRY_CODES).toContain("XK");
    expect(countryName("XK", "en")).toBe("Kosovo");
    for (const c of ["CU", "IR", "KP", "SY"]) expect(COUNTRY_CODES).not.toContain(c);
    expect(COUNTRY_CODES).toHaveLength(246);
  });

  it("uses Stripe's tax ID types, with EU VAT first for EU members", () => {
    expect(taxTypesFor("IN")).toEqual([["in_gst", "Indian GST number"]]);
    expect(taxTypesFor("DE").map(([t]) => t)).toEqual(["eu_vat", "de_stn"]);
    expect(taxTypesFor("GB").map(([t]) => t)).toEqual(["gb_vat", "eu_vat"]);
    expect(taxTypesFor("MY").map(([t]) => t)).toEqual(["my_sst", "my_frp", "my_itn"]);
    expect(taxTypesFor("AQ")).toEqual([]);
  });
});
