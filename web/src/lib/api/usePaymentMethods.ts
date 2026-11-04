"use client";

/**
 * GET /v1/billing/methods (S3D-60/62): the saved payment methods,
 * read-only. null until it answers (or when it fails).
 */

import { atom } from "jotai";
import { useCallback, useEffect } from "react";

import type { BillingMethods, SavedMethod } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { billingUidAtom } from "@/lib/billing";
import { appStore, useAppAtomValue } from "@/lib/state/stores";

/** ADR 0138: the account's saved methods in an app-store atom, for the
 * account they were read for (a user switch never shows the last one's). */
export const billingMethodsAtom = atom<{ uid: string | null; list: BillingMethods | null; error: boolean }>({
  uid: null,
  list: null,
  error: false,
});

const setList = (list: BillingMethods): void =>
  appStore.set(billingMethodsAtom, { uid: appStore.get(billingUidAtom), list, error: false });

/** Read the methods again (each reader's mount asks once). */
async function reloadWith(fetch: () => Promise<BillingMethods>): Promise<void> {
  const uid = appStore.get(billingUidAtom);
  try {
    const list = await fetch();
    if (appStore.get(billingUidAtom) === uid) appStore.set(billingMethodsAtom, { uid, list, error: false });
  } catch {
    if (appStore.get(billingUidAtom) === uid) appStore.set(billingMethodsAtom, { uid, list: null, error: true });
  }
}

function useMethodsState(): { list: BillingMethods | null; error: boolean; reload: () => Promise<void> } {
  const gateway = useGateway();
  const s = useAppAtomValue(billingMethodsAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const reload = useCallback(() => reloadWith(() => gateway.getPaymentMethods()), [gateway]);
  // and again when the account changes (sign-in lands after the mount)
  useEffect(() => {
    void reload();
  }, [reload, uid]);
  const mine = s.uid === uid;
  return { list: mine ? s.list : null, error: mine && s.error, reload };
}

export function usePaymentMethods(): SavedMethod[] | null {
  return useMethodsState().list?.methods ?? null;
}

/** spec v6.2 P10: the methods with their limit, and a way to replace the
 * list with what a change returned (or reload it). */
export function useBillingMethods(): {
  list: BillingMethods | null;
  error: boolean;
  set: (m: BillingMethods) => void;
  reload: () => Promise<void>;
} {
  const { list, error, reload } = useMethodsState();
  return { list, error, set: setList, reload };
}

/** Test hook: nothing read. */
export function resetPaymentMethodsForTests(): void {
  appStore.set(billingMethodsAtom, { uid: null, list: null, error: false });
}

/** A card past its expiry month. */
export function isExpired(m: SavedMethod, now = new Date()): boolean {
  if (!m.exp_month || !m.exp_year) return false;
  return m.exp_year < now.getFullYear() || (m.exp_year === now.getFullYear() && m.exp_month < now.getMonth() + 1);
}

const TYPE_NAMES: Record<string, string> = {
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  link: "Link",
  paypal: "PayPal",
  cashapp: "Cash App",
  klarna: "Klarna",
  alipay: "Alipay",
  wechat_pay: "WeChat Pay",
};

function brandName(brand: string): string {
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

/** "Visa •••• 4242", "Apple Pay · Visa •••• 4242", "PayPal · name@…" */
export function methodLabel(m: SavedMethod): string {
  const card = m.brand && m.last4 ? `${brandName(m.brand)} •••• ${m.last4}` : null;
  if (m.type === "card" && m.wallet) {
    const wallet = { apple_pay: "Apple Pay", google_pay: "Google Pay", link: "Link" }[m.wallet];
    return card ? `${wallet} · ${card}` : wallet;
  }
  if (m.type === "card") return card ?? "Card";
  const name = TYPE_NAMES[m.type] ?? m.type;
  const detail = card ?? (m.email ? shortEmail(m.email) : null);
  return detail ? `${name} · ${detail}` : name;
}

/** "j•••@gmail.com" (spec v6 P10) — enough to recognise it. */
function shortEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? `${email.charAt(0)}•••${email.slice(at)}` : email;
}
