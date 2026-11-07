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

import { billingVersionAtom } from "@/lib/live/liveStore";
import { atom } from "jotai";
import { useEffect } from "react";
import type { ReactNode } from "react";

import { isTeamPlan } from "@/lib/api/types";
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

/** Owner 2026-11-07: the newest billing event a read covers (the live
 * feed's billing.updated version when the read started). The balance the
 * feed sent after it is newer than the read. */
export const billingReadVersionAtom = atom<number>(0);

/** Bumped when the billing atoms are reset (sign-out, a test's cleanup):
 * an answer to a read made before it is dropped, even for the same uid. */
const billingEpochAtom = atom(0);

/** Read GET /v1/billing again; an answer for another account is dropped. */
export const refreshBillingAtom = atom(null, async (get, set): Promise<BillingStatus | null> => {
  const uid = get(billingUidAtom);
  const fetcher = fetchBilling;
  if (uid === null || fetcher === null) return null;
  const covers = get(billingVersionAtom);
  const epoch = get(billingEpochAtom);
  try {
    const s = await fetcher();
    if (get(billingEpochAtom) !== epoch) return null;
    if (get(billingUidAtom) === uid) {
      set(billingAtom, { uid, status: s, error: null });
      if (covers > get(billingReadVersionAtom)) set(billingReadVersionAtom, covers);
    }
    return s;
  } catch (e) {
    const message = e instanceof Error ? e.message : "billing status failed";
    if (get(billingEpochAtom) === epoch && get(billingUidAtom) === uid) {
      // keep the last good status (same uid): an error banner over stale
      // data beats flashing back to "unknown"
      set(billingAtom, (prev) => ({ uid, status: prev?.uid === uid ? prev.status : null, error: message }));
    }
    return null;
  }
});

/** Owner 2026-11-05: after a plan purchase or change the plan card read
 * "$0.00 of $1,500.00 usage left" until a reload, because the usage grant
 * lands a moment later (the payment's webhook). Read again every 2 s, for
 * up to 20 s, until a team plan's usage left is above zero; the latest
 * wait wins (a newer one, or another account, ends this one). */
export const PLAN_CREDIT_POLL_MS = 2_000;
export const PLAN_CREDIT_POLL_MAX_MS = 20_000;

export const planCreditWaitAtom = atom(0);

function creditArrived(s: BillingStatus | null): boolean {
  const plan = s?.plan;
  return !isTeamPlan(plan) || (plan.credit_left_cents ?? 0) > 0;
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const awaitPlanCreditAtom = atom(null, async (get, set): Promise<void> => {
  const mine = get(planCreditWaitAtom) + 1;
  set(planCreditWaitAtom, mine);
  const uid = get(billingUidAtom);
  const until = Date.now() + PLAN_CREDIT_POLL_MAX_MS;
  for (;;) {
    const s = await set(refreshBillingAtom);
    if (get(planCreditWaitAtom) !== mine || get(billingUidAtom) !== uid) return;
    if (creditArrived(s) || Date.now() + PLAN_CREDIT_POLL_MS > until) return;
    await pause(PLAN_CREDIT_POLL_MS);
    if (get(planCreditWaitAtom) !== mine) return;
  }
});

/** Read billing again now and until a plan's usage has landed. */
export function awaitPlanCredit(): Promise<void> {
  return appStore.set(awaitPlanCreditAtom);
}

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

  // owner 2026-11-07: a billing event from the live feed (a balance or a
  // settle that changed) reads the billing status again, so every place
  // that shows it agrees
  const billingVersion = useAppAtomValue(billingVersionAtom);
  useEffect(() => {
    if (billingVersion > 0) void appStore.set(refreshBillingAtom);
  }, [billingVersion]);

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
  appStore.set(planCreditWaitAtom, (n) => n + 1);
  appStore.set(billingEpochAtom, (n) => n + 1);
  appStore.set(billingReadVersionAtom, 0);
  appStore.set(billingAtom, null);
  appStore.set(billingUidAtom, null);
  fetchBilling = null;
}
