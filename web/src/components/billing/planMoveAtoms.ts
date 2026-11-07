"use client";

/**
 * Support plan moves (gateway 00155, RP-05): after a manual check, support
 * offers to move a plan to this account; only this account accepts it.
 * ADR 0138: the offers are an app-store atom for the account they were
 * read for; the gateway client is an action argument. Accept needs a
 * fresh sign-in (the shared Confirm it's you inside the client).
 */

import { atom } from "jotai";

import { GatewayError } from "@/lib/api/client";
import type { GatewayClient, PlanMoveOffer } from "@/lib/api/client";
import { billingUidAtom, refreshBillingAtom } from "@/lib/billing";
import { EN } from "@/lib/i18n/t";

type Client = Pick<GatewayClient, "getPlanMoves" | "acceptPlanMove">;

/** English (the card renders it through its translator). */
export const MOVE_EXPIRED = EN("billing.planMove.expired");
/** The fallback refusal, kept in English in the atom and translated where
 * it shows. */
export const MOVE_FAILED = EN("billing.planMove.moveFailed");

export interface PlanMovesState {
  uid: string | null;
  offers: PlanMoveOffer[] | null;
  /** per offer: its refusal, or "expired" */
  errors: Record<string, string>;
  expired: string[];
  accepted: string[];
}

export const EMPTY_PLAN_MOVES: PlanMovesState = { uid: null, offers: null, errors: {}, expired: [], accepted: [] };
export const planMovesAtom = atom<PlanMovesState>(EMPTY_PLAN_MOVES);

export const loadPlanMovesAtom = atom(null, async (get, set, client: Client): Promise<void> => {
  const uid = get(billingUidAtom);
  try {
    const offers = await client.getPlanMoves();
    if (get(billingUidAtom) === uid)
      set(planMovesAtom, (s) => ({ ...(s.uid === uid ? s : { ...EMPTY_PLAN_MOVES, uid }), uid, offers }));
  } catch {
    // nothing to show: offers are rare and the page works without them
  }
});

export const acceptPlanMoveAtom = atom(null, async (get, set, a: { client: Client; id: string }): Promise<void> => {
  const uid = get(billingUidAtom);
  const patch = (fn: (s: PlanMovesState) => PlanMovesState) => {
    if (get(billingUidAtom) === uid) set(planMovesAtom, fn);
  };
  patch((s) => {
    const errors = { ...s.errors };
    delete errors[a.id];
    return { ...s, errors };
  });
  try {
    await a.client.acceptPlanMove(a.id);
    patch((s) => ({ ...s, accepted: [...s.accepted, a.id] }));
    await set(refreshBillingAtom);
  } catch (e) {
    if (e instanceof GatewayError && (e.status === 410 || e.code === "move_expired")) {
      patch((s) => ({ ...s, expired: [...s.expired, a.id] }));
      return;
    }
    // 409: a blocker in the gateway's words; the offer stays open
    const words = e instanceof Error && e.message ? e.message : MOVE_FAILED;
    patch((s) => ({ ...s, errors: { ...s.errors, [a.id]: words } }));
  }
});
