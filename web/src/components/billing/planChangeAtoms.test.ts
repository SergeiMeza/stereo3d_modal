/**
 * ADR 0138: a plan change on the atoms (a fresh store, a stand-in
 * gateway): the latest preview wins, a failed preview charges nothing, a
 * confirm sends the previewed amount, and an expired quote is priced
 * again and waits for a second confirm.
 */
import { createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayError, type PlanChangePreview } from "@/lib/api/client";

import {
  closePlanChangeAtom,
  confirmPlanChangeAtom,
  planChangeAtom,
  previewPlanChangeAtom,
  PREVIEW_TIMEOUT_MS,
} from "./planChangeAtoms";
import { planChangeError } from "./planChangeCopy";

function preview(to: string, cents: number, quoteAt = "q1"): PlanChangePreview {
  return { to, today_cents: cents, quote_at: quoteAt } as PlanChangePreview;
}

/** Previews the test answers in any order. */
function client() {
  const previews: { to: string; resolve: (p: PlanChangePreview) => void; reject: (e: unknown) => void }[] = [];
  return {
    previews,
    previewPlanChange: (to: string) =>
      new Promise<PlanChangePreview>((resolve, reject) => previews.push({ to, resolve, reject })),
    changePlan: vi.fn(async (to: string, _quoteAt?: string) => { void _quoteAt; return { plan: to }; }),
  };
}

describe("plan change atoms", () => {
  it("latest wins: a preview for an earlier pick never shows", async () => {
    const store = createStore();
    const c = client();
    const a = store.set(previewPlanChangeAtom, { scope: "t1", client: c, to: "pro_monthly" });
    const b = store.set(previewPlanChangeAtom, { scope: "t1", client: c, to: "studio" });
    c.previews[1].resolve(preview("studio", 70000));
    await b;
    c.previews[0].resolve(preview("pro_monthly", 999));
    await a;
    const s = store.get(planChangeAtom("t1"));
    expect(s.to).toBe("studio");
    expect(s.preview?.today_cents).toBe(70000);
  });

  it("a failed preview says so and nothing can be confirmed", async () => {
    const store = createStore();
    const c = client();
    const p = store.set(previewPlanChangeAtom, { scope: "t2", client: c, to: "studio" });
    c.previews[0].reject(new Error("down"));
    await p;
    expect(store.get(planChangeAtom("t2")).previewFailed).toBe(true);
    expect(await store.set(confirmPlanChangeAtom, { scope: "t2", client: c })).toBe("none");
    expect(c.changePlan).not.toHaveBeenCalled();
  });

  it("confirm sends the previewed plan and quote", async () => {
    const store = createStore();
    const c = client();
    const p = store.set(previewPlanChangeAtom, { scope: "t3", client: c, to: "studio" });
    c.previews[0].resolve(preview("studio", 70000, "q-studio"));
    await p;
    expect(await store.set(confirmPlanChangeAtom, { scope: "t3", client: c })).toBe("done");
    expect(c.changePlan).toHaveBeenCalledWith("studio", "q-studio");
    expect(store.get(planChangeAtom("t3")).busy).toBe(false);
  });

  it("an expired quote is priced again and waits for another confirm", async () => {
    const store = createStore();
    const c = client();
    c.changePlan.mockRejectedValueOnce(new GatewayError("quote_expired", "expired", 409));
    const p = store.set(previewPlanChangeAtom, { scope: "t4", client: c, to: "studio" });
    c.previews[0].resolve(preview("studio", 70000, "q-old"));
    await p;
    const confirming = store.set(confirmPlanChangeAtom, { scope: "t4", client: c });
    await vi.waitFor(() => expect(c.previews).toHaveLength(2));
    c.previews[1].resolve(preview("studio", 71000, "q-new"));
    expect(await confirming).toBe("repriced");
    const s = store.get(planChangeAtom("t4"));
    expect(s.repriced).toBe(true);
    expect(s.preview?.today_cents).toBe(71000);
    expect(c.changePlan).toHaveBeenCalledTimes(1);
  });

  it("closing drops a preview still on its way", async () => {
    const store = createStore();
    const c = client();
    const p = store.set(previewPlanChangeAtom, { scope: "t5", client: c, to: "studio" });
    store.set(closePlanChangeAtom, "t5");
    c.previews[0].resolve(preview("studio", 70000));
    await p;
    const s = store.get(planChangeAtom("t5"));
    expect(s.to).toBeNull();
    expect(s.preview).toBeNull();
  });
});

describe("a preview that never answers (owner bug 2026-11-05)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out into previewFailed (the sheet offers Try again), and a later try still works", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const never = { previewPlanChange: () => new Promise<PlanChangePreview>(() => {}), changePlan: vi.fn() };
    const p = store.set(previewPlanChangeAtom, { scope: "t", client: never, to: "studio" });
    expect(store.get(planChangeAtom("t"))).toMatchObject({ to: "studio", preview: null, previewFailed: false });
    await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS + 1);
    await p;
    expect(store.get(planChangeAtom("t"))).toMatchObject({ to: "studio", preview: null, previewFailed: true });
    const answer = preview("studio", 1100000);
    await store.set(previewPlanChangeAtom, {
      scope: "t",
      client: { previewPlanChange: async () => answer, changePlan: vi.fn() },
      to: "studio",
    });
    expect(store.get(planChangeAtom("t"))).toMatchObject({ preview: answer, previewFailed: false });
  });
});

describe("a failed change in plain words (owner 2026-11-05)", () => {
  const fail = (code: string, message: string, status = 502, details?: Record<string, unknown>) =>
    new GatewayError(code, message, status, details);

  it("maps the gateway's reasons, sentence case, and always says nothing was charged", () => {
    expect(planChangeError(fail("payment_error", "couldn't change the plan; try again"))).toBe(
      "Couldn't change your plan. Try again. Nothing was charged.",
    );
    expect(planChangeError(fail("payment_failed", "the payment didn't go through; your plan hasn't changed", 402))).toBe(
      "Your payment didn't go through. Nothing was charged.",
    );
    expect(planChangeError(fail("payment_failed", "x", 402, { decline_code: "insufficient_funds" }))).toBe(
      "Your card was declined. Nothing was charged.",
    );
    expect(planChangeError(fail("payment_failed", "card_declined", 402))).toBe("Your card was declined. Nothing was charged.");
    expect(planChangeError(fail("payment_failed", "x", 402, { reason: "requires_action" }))).toBe(
      "Your card needs confirming. Nothing was charged.",
    );
    expect(planChangeError(fail("payment_error", "authentication_required"))).toBe(
      "Your card needs confirming. Nothing was charged.",
    );
    expect(planChangeError(fail("quote_expired", "that price has expired; preview the change again", 409))).toBe(
      "The price changed, check the new total. Nothing was charged.",
    );
    expect(planChangeError(fail("change_scheduled", "a change is already waiting; take it back first", 409))).toBe(
      "A change is already waiting. Take it back on Billing first. Nothing was charged.",
    );
    expect(planChangeError(fail("confirm_required", "send confirm: true to change the plan", 400))).toBe(
      "Couldn't change your plan. Try again. Nothing was charged.",
    );
    expect(planChangeError(new Error("Failed to fetch"))).toBe("Couldn't change your plan. Try again. Nothing was charged.");
  });

  it("a confirm that fails keeps the preview to try again, with the plain words", async () => {
    const store = createStore();
    const p = preview("studio", 1100000);
    const client = {
      previewPlanChange: async () => p,
      changePlan: vi.fn(async () => {
        throw fail("payment_error", "couldn't change the plan; try again");
      }),
    };
    await store.set(previewPlanChangeAtom, { scope: "e", client, to: "studio" });
    expect(await store.set(confirmPlanChangeAtom, { scope: "e", client })).toBe("error");
    expect(store.get(planChangeAtom("e"))).toMatchObject({
      preview: p,
      busy: false,
      error: "Couldn't change your plan. Try again. Nothing was charged.",
    });
  });
});
