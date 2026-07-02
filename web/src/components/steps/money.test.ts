import { describe, expect, it } from "vitest";

import { formatCents } from "./money";

describe("formatCents", () => {
  it("formats cents as $X.XX (never dollar floats)", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(50)).toBe("$0.50");
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCents(100000)).toBe("$1000.00");
  });

  it("formats negatives (discount lines) with a minus sign", () => {
    expect(formatCents(-50)).toBe("−$0.50");
    expect(formatCents(-100)).toBe("−$1.00");
  });
});
