import { describe, expect, it } from "vitest";

import { methodErrorCopy } from "./methods";
import { billedLength } from "./QuoteView";

describe("whole minutes, rounded up (owner 2026-11-04)", () => {
  it("shows just the billable minutes (owner: no \"rounded up\" detail)", () => {
    expect(billedLength({ billable_seconds: 130, billable_minutes: 3 })).toBe("3 min");
    expect(billedLength({ billable_seconds: 180, billable_minutes: 3 })).toBe("3 min");
  });

  it("keeps the plain length on gateways without billable_minutes", () => {
    expect(billedLength({ billable_seconds: 130 })).toBe("2 min 10 s");
  });
});

describe("Classic 3D retired (owner 2026-11-04)", () => {
  it("reads 422 classic_retired as a plain sentence with the way forward", () => {
    expect(methodErrorCopy("classic_retired")).toBe(
      "Classic 3D is retired. Your files stay here, and you can convert this project with Lifelike 3D.",
    );
  });
});
