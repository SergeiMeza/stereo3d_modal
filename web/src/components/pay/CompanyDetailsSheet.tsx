"use client";

/**
 * P16 Company details (spec v6.2, S3D-58): the name, address and tax IDs
 * that new invoices show. Country first, then the lines for it; tax IDs
 * listed with their verification and Remove; Add tax ID with the type
 * chosen from the country.
 */

import { useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { GatewayError } from "@/lib/api/client";
import type { CompanyAddress, CompanyDetails, TaxId } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

import { SheetFrame } from "./SheetFrame";

/** Countries offered first (where most customers are), then the rest by
 * name; the code is ISO 3166-1 alpha-2. */
export const COUNTRIES: [string, string][] = [
  ["US", "United States"],
  ["GB", "United Kingdom"],
  ["JP", "Japan"],
  ["DE", "Germany"],
  ["FR", "France"],
  ["CA", "Canada"],
  ["AU", "Australia"],
  ["AT", "Austria"],
  ["BE", "Belgium"],
  ["CH", "Switzerland"],
  ["CN", "China"],
  ["DK", "Denmark"],
  ["ES", "Spain"],
  ["FI", "Finland"],
  ["HK", "Hong Kong"],
  ["IE", "Ireland"],
  ["IT", "Italy"],
  ["KR", "South Korea"],
  ["NL", "Netherlands"],
  ["NO", "Norway"],
  ["NZ", "New Zealand"],
  ["PL", "Poland"],
  ["PT", "Portugal"],
  ["SE", "Sweden"],
  ["SG", "Singapore"],
  ["TW", "Taiwan"],
];

const EU = new Set(["AT", "BE", "DE", "DK", "ES", "FI", "FR", "IE", "IT", "NL", "PL", "PT", "SE"]);

/** The tax ID types a country offers: [Stripe type, label]. */
export function taxTypesFor(country: string): [string, string][] {
  if (country === "GB") return [["gb_vat", "GB VAT"]];
  if (EU.has(country)) return [["eu_vat", "EU VAT"]];
  const one: Record<string, [string, string]> = {
    US: ["us_ein", "US EIN"],
    CA: ["ca_bn", "Canadian BN"],
    AU: ["au_abn", "Australian ABN"],
    JP: ["jp_cn", "Japanese Corporate Number"],
    CH: ["ch_vat", "Swiss VAT"],
    NO: ["no_vat", "Norwegian VAT"],
    NZ: ["nz_gst", "New Zealand GST"],
    SG: ["sg_uen", "Singapore UEN"],
    KR: ["kr_brn", "Korean BRN"],
    HK: ["hk_br", "Hong Kong BR"],
    TW: ["tw_vat", "Taiwanese VAT"],
    CN: ["cn_tin", "Chinese TIN"],
  };
  return one[country] ? [one[country]] : [];
}

const VERIFY: Record<NonNullable<TaxId["verification"]>, string> = {
  verified: "Verified",
  pending: "Checking",
  unverified: "Couldn't verify",
  unavailable: "",
};

export function countryName(code: string): string {
  return COUNTRIES.find(([c]) => c === code)?.[1] ?? code;
}

/** "GB VAT · GB123456789 · Verified" */
export function taxIdLine(t: TaxId, country: string): string {
  const label =
    taxTypesFor(country).find(([type]) => type === t.type)?.[1] ??
    t.type.replace("_", " ").toUpperCase();
  const v = t.verification ? VERIFY[t.verification] : "";
  return [label, t.value, v].filter(Boolean).join(" · ");
}

/** "Kyoto Films Ltd · GB123456789 · London, UK" for Billing's summary. */
export function companySummary(c: CompanyDetails | null): string | null {
  if (!c || (!c.name && c.tax_ids.length === 0 && !c.address)) return null;
  const place = c.address
    ? [c.address.city, c.address.country === "GB" ? "UK" : countryName(c.address.country)]
        .filter(Boolean)
        .join(", ")
    : null;
  return [c.name, c.tax_ids[0]?.value, place].filter(Boolean).join(" · ") || null;
}

const field =
  "h-10 w-full rounded-lg border border-edge bg-surface-2 px-3 text-sm text-fg outline-none focus:border-primary/60";

export function CompanyDetailsSheet({
  initial,
  onClose,
}: {
  initial: CompanyDetails;
  onClose: (saved: CompanyDetails | null) => void;
}): JSX.Element {
  const gateway = useGateway();
  const [name, setName] = useState(initial.name ?? "");
  const [address, setAddress] = useState<CompanyAddress>(initial.address ?? { country: "US" });
  const [taxIds, setTaxIds] = useState<TaxId[]>(initial.tax_ids);
  const [newValue, setNewValue] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const types = taxTypesFor(address.country);
  const [newType, setNewType] = useState(types[0]?.[0] ?? "");
  const type = types.some(([t]) => t === newType) ? newType : (types[0]?.[0] ?? "");

  const set = (k: keyof CompanyAddress) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setAddress((a) => ({ ...a, [k]: e.target.value }));

  async function save(): Promise<void> {
    setState("saving");
    setMessage(null);
    try {
      let saved = await gateway.putCompany({ name: name.trim() || undefined, address });
      if (newValue.trim() && type) {
        saved = await gateway.addTaxId({ type, value: newValue.trim() });
        setNewValue("");
      }
      setTaxIds(saved.tax_ids);
      setState("saved");
      onClose(saved);
    } catch (e) {
      setState("idle");
      setMessage(
        e instanceof GatewayError && e.code === "invalid_tax_id"
          ? `That tax ID doesn't look right for ${countryName(address.country)}.`
          : "Couldn't save your details. Try again.",
      );
    }
  }

  async function removeTax(id: string): Promise<void> {
    try {
      const c = await gateway.removeTaxId(id);
      setTaxIds(c.tax_ids);
    } catch {
      setMessage("Couldn't save your details. Try again.");
    }
  }

  const usState = address.country === "US" || address.country === "CA" || address.country === "AU";
  return (
    <SheetFrame
      open
      onClose={() => onClose(null)}
      locked={state === "saving"}
      testId="company-sheet"
      title="Company details"
      footer={
        <div className="flex flex-col gap-2">
          {message ? (
            <p data-testid="company-error" className="text-sm text-red-400">
              {message}
            </p>
          ) : null}
          <Button
            size="lg"
            data-testid="company-save"
            className="h-12 w-full"
            disabled={state === "saving"}
            onClick={() => void save()}
          >
            {state === "saving" ? "Saving…" : state === "saved" ? "Saved." : "Save"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-fg-muted">Company name</span>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="organization" />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-1.5 text-xs text-fg-muted">Address</legend>
          <select aria-label="Country" className={field} value={address.country} onChange={set("country")}>
            {COUNTRIES.map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </select>
          <input aria-label="Address line 1" placeholder="Address" className={field} value={address.line1 ?? ""} onChange={set("line1")} autoComplete="address-line1" />
          <input aria-label="Address line 2" placeholder="Apartment, suite (optional)" className={field} value={address.line2 ?? ""} onChange={set("line2")} autoComplete="address-line2" />
          <div className="grid grid-cols-2 gap-2">
            <input aria-label="City" placeholder="City" className={field} value={address.city ?? ""} onChange={set("city")} autoComplete="address-level2" />
            <input aria-label="Postal code" placeholder={address.country === "US" ? "ZIP code" : "Postal code"} className={field} value={address.postal_code ?? ""} onChange={set("postal_code")} autoComplete="postal-code" />
          </div>
          {usState ? (
            <input aria-label="State" placeholder={address.country === "US" ? "State" : "Province / state"} className={field} value={address.state ?? ""} onChange={set("state")} autoComplete="address-level1" />
          ) : null}
        </fieldset>
        <section className="flex flex-col gap-2" aria-label="Tax IDs">
          <span className="text-xs text-fg-muted">Tax IDs</span>
          {taxIds.length > 0 ? (
            <ul data-testid="tax-ids" className="flex flex-col">
              {taxIds.map((t) => (
                <li key={t.id} className="flex items-center gap-2 border-t border-edge py-2 first:border-t-0">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{taxIdLine(t, address.country)}</span>
                  <button type="button" onClick={() => void removeTax(t.id)} className="text-xs text-primary hover:underline">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {types.length > 0 ? (
            <div className="flex gap-2">
              {types.length > 1 ? (
                <select aria-label="Tax ID type" className={`${field} w-auto`} value={type} onChange={(e) => setNewType(e.target.value)}>
                  {types.map(([t, l]) => (
                    <option key={t} value={t}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : null}
              <input
                aria-label="Add tax ID"
                placeholder={`Add tax ID (${types.find(([t]) => t === type)?.[1] ?? ""})`}
                className={`${field} font-mono`}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
              />
            </div>
          ) : null}
        </section>
        <p className="text-xs text-fg-muted">New invoices show these details. Earlier invoices keep what they had.</p>
      </div>
    </SheetFrame>
  );
}
