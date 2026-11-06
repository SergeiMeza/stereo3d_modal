"use client";

/**
 * Restore Purchases, step 2 (gateway 00152, owner 2026-11-06): a plan from
 * a deleted account moves to this one. First the caller's own sign-ins
 * and emails are tried (find/verify {}); otherwise an email gets a code
 * (find, always the same answer) and proves it (find/verify). Each found
 * plan says what moves and what stays; Confirm moves it (a fresh sign-in,
 * the shared Confirm it's you). ADR 0138: the step's answers live in an
 * app-store atom for the account they were asked for; the gateway client
 * is an action argument.
 */

import { atom } from "jotai";

import { GatewayError } from "@/lib/api/client";
import type { GatewayClient, RestoreOffer } from "@/lib/api/client";
import { billingUidAtom, refreshBillingAtom } from "@/lib/billing";
import { codeMailLanguage } from "@/lib/emailCode";

type Client = Pick<GatewayClient, "restoreFind" | "restoreFindVerify" | "restoreMove">;

export const RESTORED = "Your purchases are restored";
export const NOT_FOUND = "We didn't find any purchases";
export const HAS_OWN_PLAN = "This account already has a plan. Contact support to move it.";
export const CODE_SENT = "If we find purchases, we'll send a code";

export type RestoreMovePhase =
  /** nothing asked yet */
  | "idle"
  /** checking this account's own sign-ins and emails */
  | "checking"
  /** nothing matched them: ask for an email */
  | "email"
  /** a code went (or didn't) to that email */
  | "code"
  /** found plans to pick from */
  | "offers"
  | "restored"
  | "none";

export interface RestoreMoveState {
  uid: string | null;
  phase: RestoreMovePhase;
  busy: boolean;
  email: string | null;
  proofId: string | null;
  offers: RestoreOffer[];
  error: string | null;
  /** has_own_plan: Contact support */
  ownPlan: boolean;
  /** restored_elsewhere: how that account signs in */
  elsewhere: string[] | null;
}

export const EMPTY_RESTORE_MOVE: RestoreMoveState = {
  uid: null,
  phase: "idle",
  busy: false,
  email: null,
  proofId: null,
  offers: [],
  error: null,
  ownPlan: false,
  elsewhere: null,
};

export const restoreMoveAtom = atom<RestoreMoveState>(EMPTY_RESTORE_MOVE);

function providersOf(e: GatewayError): string[] {
  const p = e.details?.providers;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
}

/** A refusal's place in the state. */
function refused(e: unknown): Partial<RestoreMoveState> {
  if (e instanceof GatewayError) {
    if (e.code === "has_own_plan") return { error: HAS_OWN_PLAN, ownPlan: true };
    if (e.code === "restored_elsewhere") return { error: e.message, elsewhere: providersOf(e) };
    if (e.message) return { error: e.message };
  }
  return { error: "We couldn't check right now. Try again in a while." };
}

type Get = <V>(a: import("jotai").Atom<V>) => V;
type SetState = (a: typeof restoreMoveAtom, v: RestoreMoveState | ((s: RestoreMoveState) => RestoreMoveState)) => void;

async function step(
  get: Get,
  set: SetState,
  run: () => Promise<Partial<RestoreMoveState>>,
): Promise<void> {
  const uid = get(billingUidAtom);
  set(restoreMoveAtom, (s) => ({ ...(s.uid === uid ? s : { ...EMPTY_RESTORE_MOVE, uid }), busy: true, error: null, ownPlan: false, elsewhere: null }));
  let patch: Partial<RestoreMoveState>;
  try {
    patch = await run();
  } catch (e) {
    patch = refused(e);
  }
  if (get(billingUidAtom) !== uid) return;
  set(restoreMoveAtom, (s) => ({ ...s, ...patch, busy: false }));
}

function found(r: { proof_id: string | null; found: RestoreOffer[] }): Partial<RestoreMoveState> {
  return r.found.length > 0 && r.proof_id
    ? { phase: "offers", proofId: r.proof_id, offers: r.found }
    : { phase: "none", proofId: null, offers: [] };
}

/** Find purchases: this account's own sign-ins and emails first. */
export const findOwnAtom = atom(null, (get, set, client: Client) =>
  step(get, set, async () => {
    set(restoreMoveAtom, (s) => ({ ...s, phase: "checking" }));
    const r = await client.restoreFindVerify({});
    // nothing under them: ask for another email
    return r.found.length > 0 ? found(r) : { phase: "email" };
  }),
);

/** A code to that email (the same answer whether anything is found). */
export const findByEmailAtom = atom(null, (get, set, a: { client: Client; email: string }) =>
  step(get, set, async () => {
    const email = a.email.trim();
    await a.client.restoreFind(email, codeMailLanguage());
    return { phase: "code", email };
  }),
);

/** The code proves the email: what was found under it. */
export const verifyEmailCodeAtom = atom(null, (get, set, a: { client: Client; code: string }) =>
  step(get, set, async () => {
    const email = get(restoreMoveAtom).email ?? "";
    return found(await a.client.restoreFindVerify({ email, code: a.code }));
  }),
);

/** Move the found plan here (fresh sign-in), then read billing again. */
export const moveOfferAtom = atom(null, (get, set, a: { client: Client; offerId: string }) =>
  step(get, set, async () => {
    const proof = get(restoreMoveAtom).proofId;
    if (!proof) return { phase: "email" };
    const r = await a.client.restoreMove(proof, a.offerId);
    if (!r.restored) return { phase: "none", offers: [] };
    await set(refreshBillingAtom);
    return { phase: "restored", offers: [] };
  }),
);

/** Start again (another email). */
export const restartRestoreMoveAtom = atom(null, (get, set) => {
  set(restoreMoveAtom, { ...EMPTY_RESTORE_MOVE, uid: get(billingUidAtom), phase: "email" });
});
