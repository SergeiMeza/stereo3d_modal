"use client";

/**
 * Restore Purchases on Billing (owner 2026-11-06; ADR 0138: the answer
 * lives in an app-store atom for the account it was asked for, written
 * only by the action). The latest tap wins, a slow answer ends in an error
 * with Try again, and a restore that found or repaired something reads
 * the billing status again so the plan card shows it. The gateway client
 * is an action argument.
 */

import { atom } from "jotai";

import { GatewayError } from "@/lib/api/client";
import type { GatewayClient } from "@/lib/api/client";
import { billingUidAtom, refreshBillingAtom } from "@/lib/billing";

export interface RestoreState {
  uid: string | null;
  busy: boolean;
  /** the gateway's answer: "Your purchases are restored" or "We didn't find any purchases" */
  message: string | null;
  restored: boolean | null;
  /** why it didn't run (a refusal's own words, or a plain retry line) */
  error: string | null;
  seq: number;
}

export const EMPTY_RESTORE: RestoreState = { uid: null, busy: false, message: null, restored: null, error: null, seq: 0 };

export const restoreAtom = atom<RestoreState>(EMPTY_RESTORE);

/** The resync reads Stripe and RevenueCat a few times: give it room, but
 * never wait forever. */
export const RESTORE_TIMEOUT_MS = 45_000;

export const RESTORE_FAILED = "We couldn't check your purchases right now. Try again in a while.";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Restore Purchases for the signed-in account. */
export const runRestoreAtom = atom(
  null,
  async (get, set, client: Pick<GatewayClient, "restorePurchases">): Promise<void> => {
    const uid = get(billingUidAtom);
    const cur = get(restoreAtom);
    if (uid === null || (cur.busy && cur.uid === uid)) return;
    const mine = cur.seq + 1;
    set(restoreAtom, { ...EMPTY_RESTORE, uid, busy: true, seq: mine });
    const current = () => get(restoreAtom).seq === mine && get(billingUidAtom) === uid;
    try {
      const r = await withTimeout(client.restorePurchases(), RESTORE_TIMEOUT_MS);
      if (!current()) return;
      set(restoreAtom, (s) => ({ ...s, busy: false, message: r.message, restored: r.restored }));
      if (r.restored || r.repaired.length > 0) await set(refreshBillingAtom);
    } catch (e) {
      if (!current()) return;
      // a refusal (too many tries, a deleted account) says so in its own words
      const refused = e instanceof GatewayError && e.status >= 400 && e.status < 500 && e.message;
      set(restoreAtom, (s) => ({ ...s, busy: false, error: refused ? e.message : RESTORE_FAILED }));
    }
  },
);
