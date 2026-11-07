/**
 * Cancellation copy (owner 2026-11-08, draft): the after-it's-done lines
 * show only when the gateway says a run is charged after (deferred
 * payments, off in prod); the consent line keeps its meaning (start now;
 * the right to cancel ends when it's ready) with no EU-only period.
 */
import { describe, expect, it } from "vitest";

import { EN } from "@/lib/i18n/t";

import { POP_AFTER, POP_PRECHARGE, WITHDRAWAL_LINE, popBalance } from "@/components/pay/payCopy";

import { cancelRule, chargeRule, quoteChargeSentence } from "./billingCopy";

describe("when we charge, in words", () => {
  it("says charged after it's done only when the gateway says after", () => {
    for (const timing of [undefined, "before"] as const) {
      expect(quoteChargeSentence(timing)).toBe(EN("quote.charge.atStart"));
      expect(cancelRule(timing)).toBe(EN("quote.charge.cancelBefore"));
      expect(cancelRule(timing)).not.toMatch(/after (it's|they're) done/);
    }
    expect(quoteChargeSentence("after")).toBe(EN("quote.charge.after"));
    expect(cancelRule("after", 2500)).toBe(EN("quote.charge.cancelAfter", { amount: "$25" }));
  });

  it("every sentence of the rule starts with a capital", () => {
    const rule = chargeRule(2500);
    expect(rule).not.toMatch(/[.:]\s+[a-z]/);
    expect(rule).toContain("Runs over $25 are charged when they start");
  });
});

describe("the consent line (start now; the right to cancel ends when it's ready)", () => {
  const lines = [WITHDRAWAL_LINE, POP_AFTER, POP_PRECHARGE, popBalance(930)];
  it("asks to start now and says when the right to cancel ends, in every place it's given", () => {
    for (const l of lines) {
      expect(l).toMatch(/you ask us to (start|begin) now/);
      expect(l).toMatch(/your right to cancel ends when (it's|your 3D video is) ready\.$/);
    }
  });

  it("never states a period or says 'withdraw' or 'lose'", () => {
    for (const l of lines) {
      expect(l).not.toMatch(/14|day|withdraw|lose/i);
      expect(l).not.toMatch(/[.:]\s+[a-z]/);
    }
  });
});
