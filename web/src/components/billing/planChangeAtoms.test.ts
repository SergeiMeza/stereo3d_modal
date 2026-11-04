/**
 * ADR 0138: a plan change on the atoms (a fresh store, a stand-in
 * gateway): the latest preview wins, a failed preview charges nothing, a
 * confirm sends the previewed amount, and an expired quote is priced
 * again and waits for a second confirm.
 */
import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import { GatewayError, type PlanChangePreview } from "@/lib/api/client";

import {
  closePlanChangeAtom,
  confirmPlanChangeAtom,
  planChangeAtom,
  previewPlanChangeAtom,
} from "./planChangeAtoms";

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
