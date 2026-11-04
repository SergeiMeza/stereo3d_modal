"use client";

/**
 * Pay-as-you-go billing state (ADR 0138: in app-store atoms, no context).
 * BillingProvider (mounted once in the layout) fetches GET /v1/billing once
 * per signed-in user (the call also ensures the Stripe billing profile
 * server-side) and keeps the atoms in step with the account; refresh()
 * re-reads it at the moments the status changes: after onboarding saves a
 * card, after a settle attempt.
 *
 * status === null while signed out or until the first fetch resolves —
 * consumers must treat null as "unknown", not "no card". The state is
 * keyed by uid, so a user switch can't leak the previous account's status.
 * The gateway client is never stored in an atom: the provider registers
 * the fetch, and the atoms only keep its results.
 */

import { atom } from "jotai";
import { useEffect } from "react";
import type { ReactNode } from "react";

import type { BillingStatus } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { appStore, useAppAtomValue } from "@/lib/state/stores";

export interface BillingContextValue {
  /** null = unknown (signed out / still loading / fetch failed) */
  status: BillingStatus | null;
  /** last fetch failed — gates should fail open on errors, not lock users out */
  error: string | null;
  refresh: () => Promise<BillingStatus | null>;
}

interface BillingState {
  uid: string;
  status: BillingStatus | null;
  error: string | null;
}

/** The signed-in account's billing (null until its first answer). */
export const billingAtom = atom<BillingState | null>(null);
/** Whose billing the atoms are for (null: signed out). */
export const billingUidAtom = atom<string | null>(null);

/** The registered fetch (BillingProvider): a function, never a token. */
let fetchBilling: (() => Promise<BillingStatus>) | null = null;

/** Read GET /v1/billing again; an answer for another account is dropped. */
export const refreshBillingAtom = atom(null, async (get, set): Promise<BillingStatus | null> => {
  const uid = get(billingUidAtom);
  const fetcher = fetchBilling;
  if (uid === null || fetcher === null) return null;
  try {
    const s = await fetcher();
    if (get(billingUidAtom) === uid) set(billingAtom, { uid, status: s, error: null });
    return s;
  } catch (e) {
    const message = e instanceof Error ? e.message : "billing status failed";
    if (get(billingUidAtom) === uid) {
      // keep the last good status (same uid): an error banner over stale
      // data beats flashing back to "unknown"
      set(billingAtom, (prev) => ({ uid, status: prev?.uid === uid ? prev.status : null, error: message }));
    }
    return null;
  }
});

/** Keeps the billing atoms on the signed-in account (layout, once). */
export function BillingProvider({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const gateway = useGateway();

  useEffect(() => {
    fetchBilling = () => gateway.getBilling();
    return () => {
      fetchBilling = null;
    };
  }, [gateway]);

  useEffect(() => {
    if (!ready) return;
    const uid = user?.uid ?? null;
    if (appStore.get(billingUidAtom) === uid) return;
    appStore.set(billingUidAtom, uid);
    if (uid !== null) void appStore.set(refreshBillingAtom);
  }, [ready, user]);

  return <>{children}</>;
}

const refresh = (): Promise<BillingStatus | null> => appStore.set(refreshBillingAtom);

export function useBilling(): BillingContextValue {
  const state = useAppAtomValue(billingAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const current = state !== null && state.uid === uid ? state : null;
  return { status: current?.status ?? null, error: current?.error ?? null, refresh };
}

/** Test hook: signed out, nothing fetched, no fetch registered. */
export function resetBillingForTests(): void {
  appStore.set(billingAtom, null);
  appStore.set(billingUidAtom, null);
  fetchBilling = null;
}
