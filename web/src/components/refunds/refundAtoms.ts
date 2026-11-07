"use client";

/**
 * Refund requests (owner 2026-11-06: no automatic refunds unless the
 * customer asks; a person reviews every request; within 30 days of the
 * payment, runs and plan invoices, a cancelled plan too). ADR 0138: what
 * can be asked for, the account's requests and the open sheet are
 * app-store atoms for the account they were read for; the gateway client
 * is an action argument. The send needs a fresh sign-in, which the client
 * asks for through the shared "Confirm it's you".
 */

import { atom } from "jotai";

import type { GatewayClient, RefundOptions, SupportRequest } from "@/lib/api/client";
import { billingUidAtom } from "@/lib/billing";

type Client = Pick<
  GatewayClient,
  "getRefundOptions" | "requestRefund" | "getSupportRequests" | "replyToSupportRequest"
>;

export const NOTE_MAX = 2000;

/** The English fallbacks the atoms keep; the page reads refunds.sheet.*. */
export const OPTIONS_LOAD_FAILED = "Couldn't load what can be refunded.";
export const REQUESTS_LOAD_FAILED = "Couldn't load your requests.";

interface Loaded<T> {
  uid: string | null;
  data: T | null;
  error: string | null;
}

const empty = <T>(): Loaded<T> => ({ uid: null, data: null, error: null });

export const refundOptionsAtom = atom<Loaded<RefundOptions>>(empty<RefundOptions>());
export const supportRequestsAtom = atom<Loaded<SupportRequest[]>>(empty<SupportRequest[]>());

/** The sheet, and what it opens with already picked. */
export interface RefundSheetState {
  open: boolean;
  plan: boolean;
  conversionIds: string[];
}

export const CLOSED_SHEET: RefundSheetState = { open: false, plan: false, conversionIds: [] };
export const refundSheetAtom = atom<RefundSheetState>(CLOSED_SHEET);

export const openRefundSheetAtom = atom(
  null,
  (_get, set, pick: { plan?: boolean; conversionIds?: string[] } = {}) => {
    set(refundSheetAtom, { open: true, plan: pick.plan === true, conversionIds: pick.conversionIds ?? [] });
  },
);

export const closeRefundSheetAtom = atom(null, (_get, set) => set(refundSheetAtom, CLOSED_SHEET));

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export const loadRefundOptionsAtom = atom(null, async (get, set, client: Client): Promise<void> => {
  const uid = get(billingUidAtom);
  try {
    const data = await client.getRefundOptions();
    if (get(billingUidAtom) === uid) set(refundOptionsAtom, { uid, data, error: null });
  } catch (e) {
    if (get(billingUidAtom) === uid)
      set(refundOptionsAtom, (s) => ({ uid, data: s.uid === uid ? s.data : null, error: message(e, OPTIONS_LOAD_FAILED) }));
  }
});

export const loadSupportRequestsAtom = atom(null, async (get, set, client: Client): Promise<void> => {
  const uid = get(billingUidAtom);
  try {
    const data = await client.getSupportRequests();
    if (get(billingUidAtom) === uid) set(supportRequestsAtom, { uid, data, error: null });
  } catch (e) {
    if (get(billingUidAtom) === uid)
      set(supportRequestsAtom, (s) => ({ uid, data: s.uid === uid ? s.data : null, error: message(e, REQUESTS_LOAD_FAILED) }));
  }
});

/** Send the request, then read the options and the requests again. */
export const sendRefundRequestAtom = atom(
  null,
  async (
    _get,
    set,
    a: { client: Client; plan: boolean; conversionIds: string[]; text: string },
  ): Promise<{ merged: boolean }> => {
    const r = await a.client.requestRefund({
      ...(a.plan ? { plan: true } : {}),
      ...(a.conversionIds.length > 0 ? { conversion_ids: a.conversionIds } : {}),
      ...(a.text.trim() ? { text: a.text.trim().slice(0, NOTE_MAX) } : {}),
    });
    await Promise.all([set(loadRefundOptionsAtom, a.client), set(loadSupportRequestsAtom, a.client)]);
    return { merged: r.requests.some((x) => x.merged === true) };
  },
);

/** A reply on a request; the list shows the request as answered. */
export const replyToRequestAtom = atom(
  null,
  async (get, set, a: { client: Client; id: string; text: string }): Promise<void> => {
    const uid = get(billingUidAtom);
    const updated = await a.client.replyToSupportRequest(a.id, a.text.trim().slice(0, NOTE_MAX));
    if (get(billingUidAtom) !== uid) return;
    set(supportRequestsAtom, (s) => {
      const list = s.data ?? [];
      // a closed request's reply opens a follow-up: it goes on top
      const known = list.some((x) => x.id === updated.id);
      return { ...s, data: known ? list.map((x) => (x.id === updated.id ? updated : x)) : [updated, ...list] };
    });
  },
);

/** Test hook. */
export const EMPTY_REFUND_OPTIONS = empty<RefundOptions>();
export const EMPTY_SUPPORT_REQUESTS = empty<SupportRequest[]>();
