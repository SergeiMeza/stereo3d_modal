"use client";

/**
 * Pro on the web (S3D-68): the person's status (gateway GET /v1/pro, the
 * same rule the quotes use), the plans (GET /v1/pricing pro_plans, gateway
 * 00102), the purchase (our own payment sheet, POST /v1/pro/refresh after
 * it), and a "Pro changed" signal quotes listen to so the next price
 * carries the discount.
 *
 * Mock auth mode (tests, the dev preview) reads its status from the mock
 * gateway's state (window.__mockDb) instead of calling GET /v1/pro.
 */

import { atom } from "jotai";
import { useCallback, useEffect } from "react";

import { clearStepQuotes } from "@/components/steps/checkoutStore";
import { AUTH_MODE, useAuth } from "@/lib/auth";
import { gatewayBaseUrl } from "@/lib/region";
import type { GatewayClient } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { openProCheckout, proCheckoutAtom } from "@/lib/pro/checkoutStore";
import { anchorLine, anchorPlan, plansFromPricing } from "@/lib/pro/plans";
import { appStore, useAppAtomValue } from "@/lib/state/stores";
import type { ProPlan } from "@/lib/pro/plans";

export interface ProStatus {
  pro: boolean;
  /** what makes them Pro: a product id ("pro_subs_1y_v1"; App Store passes count too) */
  via?: string;
  /** false when the gateway couldn't tell */
  known: boolean;
  /** where this Pro is billed (owner 2026-11-04): the App Store, the Mac
   * App Store, the web, included with a plan, or simulated */
  source?: "app_store" | "mac_app_store" | "rc_billing" | "stripe" | "plan" | "simulated" | string | null;
  /** the store's subscription page (App Store sources) */
  management_url?: string | null;
  /** gateway 00102: source "plan" — our own plan's id (pro_monthly,
   * business…) and a step-down waiting for the period's end */
  plan_id?: string | null;
  scheduled_change?: { to: string; effective_at: string } | null;
  /** gateway 00096: the free previews this Pro includes */
  free_previews?: { allowance: number; per_period?: number; period?: string } | null;
}

// ------------------------------------------------------------- signal
//
// ADR 0138: Pro's status, plans and "Pro changed" count live in app-store
// atoms (no module caches or listener sets); the token getter and the
// gateway client are passed to the loads, never stored.

/** Bumps after every purchase in this page session; 0 until then. */
export const proEpochAtom = atom(0);

/** The signed-in person's status, for the account and epoch it was read
 * for (loading while a read is on its way). */
export const proStatusAtom = atom<{ uid: string; epoch: number; status: ProStatus | null; loading: boolean } | null>(
  null,
);

/** The plans on sale, for the account they were read for. */
export const proPlansAtom = atom<{ uid: string; v: PlansState; loading: boolean } | null>(null);

/** the mock gateway's own purchase (mock auth only, tests and previews) */
let mockPro = false;

/** Pro just changed (a purchase): status and quotes ask again. */
export function notifyProChanged(): void {
  // the status is read again for the new epoch; the last one shows
  // meanwhile (a sheet open on it stays put)
  appStore.set(proEpochAtom, (n) => n + 1);
  clearStepQuotes();
}

/** Bumps after every purchase in this page session; 0 until then. */
export function useProEpoch(): number {
  return useAppAtomValue(proEpochAtom);
}

/** Tests: forget everything. */
export function resetProForTests(): void {
  mockPro = false;
  appStore.set(proEpochAtom, 0);
  appStore.set(proStatusAtom, null);
  appStore.set(proPlansAtom, null);
  appStore.set(proCheckoutAtom, null);
}

// ------------------------------------------------------------- status

async function callGateway(
  getToken: () => Promise<string>,
  fresh: boolean,
): Promise<ProStatus> {
  if (AUTH_MODE === "mock") {
    // the mock gateway's "Simulate app Pro" (test only): Pro from the app
    const db = (
      globalThis as {
        __mockDb?: { accountSettings?: { simulate_app_pro?: boolean }; proStatus?: ProStatus | null };
      }
    ).__mockDb;
    // tests and screenshots: a fixed Pro (an App Store or web subscription)
    if (db?.proStatus) return db.proStatus;
    if (db?.accountSettings?.simulate_app_pro) {
      return {
        pro: true,
        via: "simulated_app_pro",
        known: true,
        source: "simulated",
        free_previews: { allowance: 20, per_period: 20, period: "month" },
      };
    }
    return { pro: mockPro, known: true };
  }
  const token = await getToken();
  const res = await fetch(
    `${gatewayBaseUrl()}/v1/pro${fresh ? "/refresh" : ""}`,
    {
      method: fresh ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) return { pro: false, known: false };
  const body = (await res.json()) as Partial<ProStatus>;
  return {
    pro: body.pro === true,
    via: body.via,
    known: body.known === true,
    free_previews: body.free_previews ?? null,
    source: body.source ?? null,
    management_url: body.management_url ?? null,
    plan_id: body.plan_id ?? null,
    scheduled_change: body.scheduled_change ?? null,
  };
}

/** Read the status for `uid` unless it's read (or on its way) for this
 * epoch. */
async function loadStatus(uid: string, getToken: () => Promise<string>): Promise<void> {
  const epoch = appStore.get(proEpochAtom);
  const cur = appStore.get(proStatusAtom);
  if (cur && cur.uid === uid && cur.epoch === epoch && (cur.status !== null || cur.loading)) return;
  appStore.set(proStatusAtom, { uid, epoch, status: cur?.uid === uid ? cur.status : null, loading: true });
  const status = await callGateway(getToken, false).catch(() => ({ pro: false, known: false }));
  const now = appStore.get(proStatusAtom);
  if (now?.uid === uid && now.epoch === epoch) appStore.set(proStatusAtom, { uid, epoch, status, loading: false });
}

/** The signed-in person's Pro status; null while loading or signed out. */
export function useProStatus(): ProStatus | null {
  const { user, getToken } = useAuth();
  const uid = user?.uid ?? null;
  const epoch = useProEpoch();
  const s = useAppAtomValue(proStatusAtom);
  useEffect(() => {
    if (uid !== null) void loadStatus(uid, getToken);
  }, [uid, getToken, epoch, s]);
  return s !== null && s.uid === uid ? s.status : null;
}

// -------------------------------------------------------------- plans

/** gateway 00102: web Pro on our own Stripe subscriptions (pricing
 * pro_plans); nothing on sale when the list is empty. */
async function loadPlansFor(gateway: GatewayClient): Promise<ProPlan[]> {
  const pricing = await gateway.getPricing();
  return plansFromPricing(pricing.pro_plans ?? []);
}

export type PlansState =
  | { state: "loading" }
  | { state: "ready"; plans: ProPlan[] }
  | { state: "error"; message: string };

/** Read the plans for `uid` unless they're read or on their way; a
 * failure is tried again on the next reader's mount. */
async function loadPlans(uid: string, gateway: GatewayClient): Promise<void> {
  const cur = appStore.get(proPlansAtom);
  if (cur && cur.uid === uid && (cur.loading || cur.v.state === "ready")) return;
  appStore.set(proPlansAtom, { uid, v: cur?.uid === uid ? cur.v : { state: "loading" }, loading: true });
  let v: PlansState;
  try {
    v = { state: "ready", plans: await loadPlansFor(gateway) };
  } catch (e) {
    v = { state: "error", message: e instanceof Error ? e.message : "Plans didn't load." };
  }
  if (appStore.get(proPlansAtom)?.uid === uid) appStore.set(proPlansAtom, { uid, v, loading: false });
}

/** The plans on sale to the signed-in person. */
export function useProPlans(): PlansState {
  const { user } = useAuth();
  const gateway = useGateway();
  const uid = user?.uid ?? null;
  const st = useAppAtomValue(proPlansAtom);
  useEffect(() => {
    if (uid !== null) void loadPlans(uid, gateway);
  }, [uid, gateway]);
  return st !== null && st.uid === uid ? st.v : { state: "loading" };
}

/** One price line for the quote's "Pro members save" sheet: Monthly as the
 * anchor ("$8.99 a month"), else the plan that costs least per month. null
 * while loading, signed out, or with nothing on sale. */
export function useProOffer(): { plan: ProPlan; line: string } | null {
  const plans = useProPlans();
  if (plans.state !== "ready") return null;
  const plan = anchorPlan(plans.plans);
  return plan ? { plan, line: anchorLine(plan) } : null;
}

// ----------------------------------------------------------- purchase

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Buy plan, then ask the gateway again (past its cache) until it sees Pro,
 * and tell quotes. "cancelled" when the person closed the checkout. */
export function useBuyPro(): (
  plan: ProPlan,
) => Promise<"purchased" | "cancelled"> {
  const { user, getToken } = useAuth();
  return useCallback(
    async (plan: ProPlan) => {
      if (!user) throw new Error("Sign in to get Pro.");
      const outcome = await openProCheckout(plan);
      if (outcome === "cancelled") return outcome;
      // attribution and the new state: POST /v1/pro/refresh until it says Pro
      for (let i = 0; i < 4; i++) {
        const s = await callGateway(getToken, true).catch(() => null);
        if (s?.pro) break;
        await sleep(1500);
      }
      if (AUTH_MODE === "mock") mockPro = true;
      notifyProChanged();
      return outcome;
    },
    [user, getToken],
  );
}

/** Pro on our own Stripe subscription (gateway 00102: source "plan" with a
 * pro_* plan_id; "stripe" from the mock before it). */
export function isWebPro(s: ProStatus | null | undefined): boolean {
  if (!s?.pro) return false;
  if (s.source === "stripe" || s.source === "rc_billing") return true;
  return s.source === "plan" && (s.plan_id ?? "").startsWith("pro_");
}
