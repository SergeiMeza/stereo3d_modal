"use client";

/**
 * Billing's records (ADR 0138): the purchases, the invoices and the
 * business details, each in one app-store atom for the account it was read
 * for, written by its load action (a first page replaces, "Show more"
 * appends). The gateway client is an action argument.
 */

import { atom } from "jotai";

import type { GatewayClient } from "@/lib/api/client";
import type { BillingHistory, BillingRow, CompanyDetails, InvoiceRow } from "@/lib/api/types";
import { billingUidAtom } from "@/lib/billing";

export interface BillingHistoryState {
  uid: string | null;
  rows: BillingRow[] | null;
  hasMore: boolean;
  tax: BillingHistory["tax"];
  /** the first page didn't load */
  error: boolean;
}

export const EMPTY_HISTORY: BillingHistoryState = { uid: null, rows: null, hasMore: false, tax: "off", error: false };

export const billingHistoryAtom = atom<BillingHistoryState>(EMPTY_HISTORY);

/** Load the first page, or the page after `after`. */
export const loadBillingHistoryAtom = atom(
  null,
  async (
    get,
    set,
    a: { client: Pick<GatewayClient, "getBillingHistory">; rowsOf: (h: BillingHistory) => BillingRow[]; after?: string },
  ): Promise<void> => {
    const uid = get(billingUidAtom);
    try {
      const h = await a.client.getBillingHistory(a.after);
      if (get(billingUidAtom) !== uid) return;
      const page = a.rowsOf(h);
      set(billingHistoryAtom, (s) => ({
        uid,
        rows: a.after && s.uid === uid && s.rows ? [...s.rows, ...page] : page,
        hasMore: h.has_more === true,
        tax: h.tax ?? "off",
        error: false,
      }));
    } catch {
      if (!a.after && get(billingUidAtom) === uid) set(billingHistoryAtom, { ...EMPTY_HISTORY, uid, error: true });
    }
  },
);

// ------------------------------------------------- invoices and company

export interface InvoicesState {
  uid: string | null;
  rows: InvoiceRow[] | null;
  hasMore: boolean;
  /** the first page didn't load */
  error: boolean;
}

export const EMPTY_INVOICES: InvoicesState = { uid: null, rows: null, hasMore: false, error: false };

/** The account's invoices (GET /v1/billing/invoices). */
export const invoicesAtom = atom<InvoicesState>(EMPTY_INVOICES);

/** Load the first page of invoices, or the page after `after`. */
export const loadInvoicesAtom = atom(
  null,
  async (get, set, a: { client: Pick<GatewayClient, "getInvoices">; after?: string }): Promise<void> => {
    const uid = get(billingUidAtom);
    try {
      const l = await a.client.getInvoices(a.after);
      if (get(billingUidAtom) !== uid) return;
      set(invoicesAtom, (s) => ({
        uid,
        rows: a.after && s.uid === uid && s.rows ? [...s.rows, ...l.invoices] : l.invoices,
        hasMore: l.has_more === true,
        error: false,
      }));
    } catch {
      if (!a.after && get(billingUidAtom) === uid) set(invoicesAtom, { ...EMPTY_INVOICES, uid, error: true });
    }
  },
);

export interface CompanyState {
  uid: string | null;
  company: CompanyDetails | null;
  loaded: boolean;
}

export const EMPTY_COMPANY: CompanyState = { uid: null, company: null, loaded: false };

/** The account's business details (GET /v1/billing/company). */
export const companyAtom = atom<CompanyState>(EMPTY_COMPANY);

export const loadCompanyAtom = atom(
  null,
  async (get, set, client: Pick<GatewayClient, "getCompany">): Promise<void> => {
    const uid = get(billingUidAtom);
    let company: CompanyDetails | null = null;
    try {
      company = await client.getCompany();
    } catch {
      company = null;
    }
    if (get(billingUidAtom) === uid) set(companyAtom, { uid, company, loaded: true });
  },
);
