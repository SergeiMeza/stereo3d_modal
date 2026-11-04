"use client";

/**
 * The account's purchases (GET /v1/billing/history, ADR 0138): one
 * app-store atom for the account they were read for, written by the load
 * action (the first page replaces, "Show more" appends). The gateway
 * client is an action argument.
 */

import { atom } from "jotai";

import type { GatewayClient } from "@/lib/api/client";
import type { BillingHistory, BillingRow } from "@/lib/api/types";
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
