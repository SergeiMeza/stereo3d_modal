"use client";

/**
 * Account → Business details (owner 2026-11-04): what future invoices show
 * — company name, billing address, tax ID, a billing email for invoice
 * copies and an optional purchase order reference. GET/PUT
 * /v1/billing/company; Checkout fills it the first time. Saving says
 * "Saved. Your next invoices will use these details."; a 400 shows
 * Stripe's tax ID message. Open to every account (Business and Studio,
 * and anyone else who wants invoices with company details).
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { GatewayError } from "@/lib/api/client";
import type { CompanyAddress, CompanyDetails } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { localeCountry, taxTypesFor } from "@/lib/company";
import { useT } from "@/lib/i18n/I18nProvider";

import { CountryCombobox, useDetectedCountry } from "./CountryCombobox";

/** English (tests); the form reads company.form.saved. */
export const SAVED_LINE = "Saved. Your next invoices will use these details.";

interface Draft {
  company_name: string;
  address: Required<Omit<CompanyAddress, "country">> & { country: string };
  tax_type: string;
  tax_value: string;
  billing_email: string;
  po_reference: string;
}

function draftOf(c: CompanyDetails): Draft {
  // a new form starts at the browser language's country
  const country = c.address?.country ?? localeCountry() ?? "US";
  return {
    company_name: c.company_name ?? "",
    address: {
      line1: c.address?.line1 ?? "",
      line2: c.address?.line2 ?? "",
      city: c.address?.city ?? "",
      postal_code: c.address?.postal_code ?? "",
      state: c.address?.state ?? "",
      country,
    },
    tax_type: c.tax_id?.type ?? taxTypesFor(country)[0]?.[0] ?? "",
    tax_value: c.tax_id?.value ?? "",
    billing_email: c.billing_email ?? "",
    po_reference: c.po_reference ?? "",
  };
}

const trimmed = (s: string) => (s.trim() ? s.trim() : null);

function bodyOf(d: Draft): CompanyDetails {
  const a = d.address;
  return {
    company_name: trimmed(d.company_name),
    address: {
      country: a.country,
      ...(a.line1.trim() ? { line1: a.line1.trim() } : {}),
      ...(a.line2.trim() ? { line2: a.line2.trim() } : {}),
      ...(a.city.trim() ? { city: a.city.trim() } : {}),
      ...(a.postal_code.trim() ? { postal_code: a.postal_code.trim() } : {}),
      ...(a.state.trim() ? { state: a.state.trim() } : {}),
    },
    tax_id:
      d.tax_value.trim() && d.tax_type
        ? { type: d.tax_type, value: d.tax_value.trim() }
        : null,
    billing_email: trimmed(d.billing_email),
    po_reference: trimmed(d.po_reference),
  };
}

export function BusinessDetailsForm(): JSX.Element {
  const t = useT();
  const gateway = useGateway();
  const detected = useDetectedCountry();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [taxError, setTaxError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    gateway.getCompany().then(
      (c) => live && setDraft(draftOf(c)),
      () => {
        if (!live) return;
        setLoadError(true);
        setDraft(draftOf({}));
      },
    );
    return () => {
      live = false;
    };
  }, [gateway]);

  if (draft === null) {
    return (
      <div
        className="h-96 animate-pulse rounded-xl bg-surface-1"
        data-testid="company-loading"
      />
    );
  }

  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setState("idle");
  };
  const setAddr = (patch: Partial<Draft["address"]>) => {
    const address = { ...draft.address, ...patch };
    const types = taxTypesFor(address.country, t);
    set({
      address,
      // a new country brings its own tax ID type
      ...(patch.country !== undefined &&
      !types.some(([type]) => type === draft.tax_type)
        ? { tax_type: types[0]?.[0] ?? "" }
        : {}),
    });
  };
  const types = taxTypesFor(draft.address.country, t);

  async function save(): Promise<void> {
    if (!draft) return;
    setState("saving");
    setError(null);
    setTaxError(null);
    try {
      const saved = await gateway.putCompany(bodyOf(draft));
      setDraft(draftOf(saved));
      setState("saved");
    } catch (e) {
      setState("idle");
      if (e instanceof GatewayError && e.status === 400) {
        // Stripe's own words about the tax ID (or the field it names)
        if (e.code.includes("tax")) setTaxError(e.message);
        else setError(e.message);
      } else setError(t("company.form.saveFailed"));
    }
  }

  return (
    <form
      data-testid="company-form"
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {loadError ? (
        <p className="text-sm text-fg-muted">{t("company.form.loadFailed")}</p>
      ) : null}
      <Field id="company-name" label={t("company.form.companyName")}>
        <Input
          id="company-name"
          autoComplete="organization"
          value={draft.company_name}
          maxLength={200}
          onChange={(e) => set({ company_name: e.target.value })}
        />
      </Field>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium text-fg">
          {t("company.form.billingAddress")}
        </legend>
        <Field id="company-country" label={t("company.form.country")}>
          <CountryCombobox
            id="company-country"
            value={draft.address.country}
            detected={detected}
            onChange={(country) => setAddr({ country })}
          />
        </Field>
        <Field id="company-line1" label={t("company.form.line1")}>
          <Input
            id="company-line1"
            autoComplete="address-line1"
            value={draft.address.line1}
            onChange={(e) => setAddr({ line1: e.target.value })}
          />
        </Field>
        <Field id="company-line2" label={t("company.form.line2")}>
          <Input
            id="company-line2"
            autoComplete="address-line2"
            value={draft.address.line2}
            onChange={(e) => setAddr({ line2: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="company-city" label={t("company.form.city")}>
            <Input
              id="company-city"
              autoComplete="address-level2"
              value={draft.address.city}
              onChange={(e) => setAddr({ city: e.target.value })}
            />
          </Field>
          <Field id="company-postal" label={t("company.form.postalCode")}>
            <Input
              id="company-postal"
              autoComplete="postal-code"
              value={draft.address.postal_code}
              onChange={(e) => setAddr({ postal_code: e.target.value })}
            />
          </Field>
          <Field id="company-state" label={t("company.form.state")}>
            <Input
              id="company-state"
              autoComplete="address-level1"
              value={draft.address.state}
              onChange={(e) => setAddr({ state: e.target.value })}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium text-fg">
          {t("company.form.taxId")}
        </legend>
        {types.length > 0 ? (
          <div
            className={
              types.length > 1
                ? "grid gap-3 sm:grid-cols-[minmax(0,16rem)_1fr]"
                : "grid gap-3"
            }
          >
            {/* more than one type (e.g. Brazil's CNPJ or CPF): pick it */}
            {types.length > 1 ? (
              <Field id="company-tax-type" label={t("company.form.taxType")}>
                <NativeSelect
                  id="company-tax-type"
                  value={draft.tax_type}
                  onChange={(e) => set({ tax_type: e.target.value })}
                >
                  {types.map(([type, label]) => (
                    <NativeSelectOption key={type} value={type}>
                      {label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            <Field
              id="company-tax-value"
              label={types.length === 1 ? types[0][1] : t("company.form.taxNumber")}
            >
              <Input
                id="company-tax-value"
                value={draft.tax_value}
                aria-invalid={taxError !== null}
                aria-describedby={taxError ? "company-tax-error" : undefined}
                onChange={(e) => {
                  set({ tax_value: e.target.value });
                  setTaxError(null);
                }}
              />
            </Field>
          </div>
        ) : (
          <p className="text-xs text-fg-muted">{t("company.form.noTaxId")}</p>
        )}
        {taxError ? (
          <p
            id="company-tax-error"
            role="alert"
            data-testid="company-tax-error"
            className="text-xs text-destructive"
          >
            {taxError}
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="company-email" label={t("company.form.billingEmail")}>
          <Input
            id="company-email"
            type="email"
            autoComplete="email"
            value={draft.billing_email}
            onChange={(e) => set({ billing_email: e.target.value })}
          />
        </Field>
        <Field id="company-po" label={t("company.form.poReference")}>
          <Input
            id="company-po"
            value={draft.po_reference}
            maxLength={100}
            onChange={(e) => set({ po_reference: e.target.value })}
          />
        </Field>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          data-testid="company-save"
          disabled={state === "saving"}
        >
          {state === "saving" ? t("company.form.saving") : t("company.form.save")}
        </Button>
        {state === "saved" ? (
          <p
            role="status"
            data-testid="company-saved"
            className="text-sm text-fg"
          >
            {t("company.form.saved")}
          </p>
        ) : null}
        <Link
          href="/account/billing"
          className="ms-auto text-sm text-primary hover:underline"
        >
          {t("company.form.billingLink")}
        </Link>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
