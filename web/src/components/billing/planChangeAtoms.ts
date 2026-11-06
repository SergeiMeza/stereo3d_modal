"use client";

/**
 * A plan change in progress (ADR 0138): the preview (today's price for
 * the change), whether it failed, and the confirm, in one atom per place
 * that changes plans ("plan-menu" on Billing, "pro-period" on the Pro
 * page, "business-setup"). The action atoms are its only writers:
 *
 * - latest wins: opening another target drops an answer still on its way
 *   for the one before (a stale price never shows);
 * - confirm sends the previewed amount; an expired quote is priced again
 *   and waits for a second confirm (`repriced`), nothing is charged before.
 *
 * The gateway client is an action argument, never stored.
 */

import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import { GatewayError } from "@/lib/api/client";
import type { GatewayClient, PlanChangePreview } from "@/lib/api/client";

import { confirmPlanChange } from "./planChangeCopy";

export interface PlanChangeState {
  /** the plan being previewed (null: nothing open) */
  to: string | null;
  preview: PlanChangePreview | null;
  /** the preview couldn't be worked out (nothing was charged) */
  previewFailed: boolean;
  /** the confirm's words when it failed */
  error: string | null;
  /** the price changed (an expired quote): confirm again */
  repriced: boolean;
  busy: boolean;
  seq: number;
}

const EMPTY: PlanChangeState = {
  to: null,
  preview: null,
  previewFailed: false,
  error: null,
  repriced: false,
  busy: false,
  seq: 0,
};

export const planChangeAtom = atomFamily((scope: string) => {
  void scope;
  return atom<PlanChangeState>(EMPTY);
});

type Client = Pick<GatewayClient, "previewPlanChange" | "changePlan">;

/** owner bug 2026-11-05: a preview that never answers ends as failed (with
 * Try again) instead of a button that waits forever. */
export const PREVIEW_TIMEOUT_MS = 10_000;

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

/** Price the change to `to` (and forget any earlier one). */
export const previewPlanChangeAtom = atom(
  null,
  async (get, set, a: { scope: string; client: Client; to: string }): Promise<void> => {
    const at = planChangeAtom(a.scope);
    const mine = get(at).seq + 1;
    set(at, { ...EMPTY, to: a.to, seq: mine });
    try {
      const preview = await withTimeout(a.client.previewPlanChange(a.to), PREVIEW_TIMEOUT_MS);
      if (get(at).seq === mine) set(at, (s) => ({ ...s, preview }));
    } catch (e) {
      // the coordinator 2026-11-06: a refusal shows the gateway's own
      // words (e.g. a change it can't make now), never a dead end
      const refused = e instanceof GatewayError && e.status >= 400 && e.status < 500 && e.message;
      if (get(at).seq === mine)
        set(at, (s) => (refused ? { ...s, error: e.message } : { ...s, previewFailed: true }));
    }
  },
);

/** Close the change (an answer still on its way is dropped). */
export const closePlanChangeAtom = atom(null, (get, set, scope: string) => {
  const at = planChangeAtom(scope);
  set(at, { ...EMPTY, seq: get(at).seq + 1 });
});

/** Confirm the previewed change: "done", "repriced" (the new price shows
 * and waits for another confirm), "error" (its words in the state) or
 * "none" (no preview to confirm). */
export const confirmPlanChangeAtom = atom(
  null,
  async (get, set, a: { scope: string; client: Client }): Promise<"done" | "repriced" | "error" | "none"> => {
    const at = planChangeAtom(a.scope);
    const s = get(at);
    if (!s.preview || s.busy) return "none";
    const mine = s.seq;
    set(at, { ...s, busy: true, error: null, repriced: false });
    const r = await confirmPlanChange(a.client, s.preview);
    if (get(at).seq !== mine) return r.kind;
    if (r.kind === "done") set(at, (x) => ({ ...x, busy: false }));
    else if (r.kind === "repriced") set(at, (x) => ({ ...x, busy: false, preview: r.preview, repriced: true }));
    else set(at, (x) => ({ ...x, busy: false, error: r.message }));
    return r.kind;
  },
);

/** Test hook: every plan change closed. */
export function resetPlanChangesForTests(): void {
  for (const k of [...planChangeAtom.getParams()]) planChangeAtom.remove(k);
}
