"use client";

/**
 * Pro on the web (S3D-68): the person's status (gateway GET /v1/pro, the
 * same RevenueCat rule the quotes use), the plans (RevenueCat Web Billing),
 * the purchase, and a "Pro changed" signal quotes listen to so the next
 * price carries the discount.
 *
 * Mock auth mode (tests, the dev preview) never loads the SDK or calls the
 * gateway: it shows MOCK_PLANS, and a mock purchase flips the dev preview's
 * mock gateway to Pro (window.__mockDb.pro) so its quotes show the line.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { clearStepQuotes } from "@/components/steps/checkoutStore";
import { AUTH_MODE, useAuth } from "@/lib/auth";
import { gatewayBaseUrl } from "@/lib/region";
import { anchorLine, anchorPlan, MOCK_PLANS } from "@/lib/pro/plans";
import type { ProPlan } from "@/lib/pro/plans";

export interface ProStatus {
  pro: boolean;
  /** what makes them Pro: a product id ("pro_subs_1y_v1"; App Store passes count too) */
  via?: string;
  /** false when RevenueCat couldn't tell */
  known: boolean;
  /** gateway 00096: the free previews this Pro includes */
  free_previews?: { allowance: number; per_period?: number; period?: string } | null;
}

// ------------------------------------------------------------- signal

let epoch = 0;
const listeners = new Set<() => void>();
let mockPro = false;

/** Pro just changed (a purchase): status and quotes ask again. */
export function notifyProChanged(): void {
  epoch += 1;
  statusCache.clear();
  clearStepQuotes();
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Bumps after every purchase in this page session; 0 until then. */
export function useProEpoch(): number {
  return useSyncExternalStore(
    subscribe,
    () => epoch,
    () => 0,
  );
}

/** Tests: forget everything. */
export function resetProForTests(): void {
  epoch = 0;
  mockPro = false;
  statusCache.clear();
  plansCache.clear();
  listeners.clear();
}

// ------------------------------------------------------------- status

const statusCache = new Map<string, Promise<ProStatus>>();

async function callGateway(
  getToken: () => Promise<string>,
  fresh: boolean,
): Promise<ProStatus> {
  if (AUTH_MODE === "mock") {
    // the mock gateway's "Simulate app Pro" (test only): Pro from the app
    const db = (globalThis as { __mockDb?: { accountSettings?: { simulate_app_pro?: boolean } } }).__mockDb;
    if (db?.accountSettings?.simulate_app_pro) {
      return { pro: true, via: "simulated_app_pro", known: true, free_previews: { allowance: 20, per_period: 20, period: "month" } };
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
  return { pro: body.pro === true, via: body.via, known: body.known === true, free_previews: body.free_previews ?? null };
}

/** The signed-in person's Pro status; null while loading or signed out. */
export function useProStatus(): ProStatus | null {
  const { user, getToken } = useAuth();
  const uid = user?.uid ?? null;
  const tick = useProEpoch();
  const [status, setStatus] = useState<{ uid: string; s: ProStatus } | null>(
    null,
  );
  useEffect(() => {
    if (uid === null) return;
    let cancelled = false;
    let p = statusCache.get(uid);
    if (!p) {
      p = callGateway(getToken, false).catch(() => ({ pro: false, known: false }));
      statusCache.set(uid, p);
    }
    void p.then((s) => {
      if (!cancelled) setStatus({ uid, s });
    });
    return () => {
      cancelled = true;
    };
  }, [uid, getToken, tick]);
  return status !== null && status.uid === uid ? status.s : null;
}

// -------------------------------------------------------------- plans

const plansCache = new Map<string, Promise<ProPlan[]>>();

async function loadPlansFor(uid: string): Promise<ProPlan[]> {
  if (AUTH_MODE === "mock") return MOCK_PLANS;
  const { loadPlans } = await import("@/lib/pro/revenuecat");
  return loadPlans(uid);
}

export type PlansState =
  | { state: "loading" }
  | { state: "ready"; plans: ProPlan[] }
  | { state: "error"; message: string };

/** The plans on sale to the signed-in person. */
export function useProPlans(): PlansState {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const [st, setSt] = useState<{ uid: string; v: PlansState } | null>(null);
  useEffect(() => {
    if (uid === null) return;
    let cancelled = false;
    let p = plansCache.get(uid);
    if (!p) {
      p = loadPlansFor(uid);
      plansCache.set(uid, p);
      p.catch(() => plansCache.delete(uid));
    }
    p.then(
      (plans) => {
        if (!cancelled) setSt({ uid, v: { state: "ready", plans } });
      },
      (e: unknown) => {
        if (!cancelled)
          setSt({
            uid,
            v: {
              state: "error",
              message: e instanceof Error ? e.message : "Plans didn't load.",
            },
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [uid]);
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
      if (AUTH_MODE === "mock") {
        await sleep(400);
        mockPro = true;
        const db = (globalThis as { __mockDb?: { pro?: boolean } }).__mockDb;
        if (db) db.pro = true;
        notifyProChanged();
        return "purchased";
      }
      const { purchasePlan } = await import("@/lib/pro/revenuecat");
      const outcome = await purchasePlan(user.uid, plan.id, user.email);
      if (outcome === "cancelled") return outcome;
      // RevenueCat may take a moment to report the new purchase.
      for (let i = 0; i < 4; i++) {
        const s = await callGateway(getToken, true).catch(() => null);
        if (s?.pro) break;
        await sleep(1500);
      }
      notifyProChanged();
      return outcome;
    },
    [user, getToken],
  );
}

/** Where a web subscriber manages the plan; null otherwise. */
export async function proManagementUrl(uid: string): Promise<string | null> {
  if (AUTH_MODE === "mock") return null;
  const { managementUrl } = await import("@/lib/pro/revenuecat");
  return managementUrl(uid);
}
