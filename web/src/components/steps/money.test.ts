import { describe, expect, it } from "vitest";

import { formatCents, groupMoney } from "./money";

describe("formatCents", () => {
  it("formats cents as $X.XX (never dollar floats)", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(50)).toBe("$0.50");
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCents(100000)).toBe("$1,000.00");
  });

  it("formats negatives (discount lines) with a minus sign", () => {
    expect(formatCents(-50)).toBe("−$0.50");
    expect(formatCents(-100)).toBe("−$1.00");
  });
});

describe("groupMoney (owner 2026-11-05: every Billing amount groups its thousands)", () => {
  it("rewrites the gateway's amounts in text, and leaves grouped ones", () => {
    expect(groupMoney("Usage credit added · $1500.00")).toBe("Usage credit added · $1,500.00");
    expect(groupMoney("Balance top-up · $25.00")).toBe("Balance top-up · $25.00");
    expect(groupMoney("Studio plan $11988.00 − $1000.00")).toBe("Studio plan $11,988.00 − $1,000.00");
    expect(groupMoney("Usage credit added · $1,500.00")).toBe("Usage credit added · $1,500.00");
    expect(groupMoney("Credit -$1200")).toBe("Credit −$1,200");
    expect(groupMoney("Business plan · monthly")).toBe("Business plan · monthly");
  });
});
