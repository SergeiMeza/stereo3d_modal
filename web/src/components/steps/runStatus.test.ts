import { describe, expect, it } from "vitest";

import type { Conversion } from "@/lib/api/types";
import { formatDuration, formatTimeLeft, formatVideoLength } from "@/lib/format";

import { runStatus } from "./runStatus";

function run(over: Partial<Conversion>): Conversion {
  return {
    conversion_id: "c1",
    state: "processing",
    kind: "video",
    params: { preset: "1080p", formats: ["sbs"] },
    quote: { amount_cents: 3000, currency: "usd" },
    progress: 0.2,
    created_at: "2026-11-03T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
    ...over,
  };
}

describe("runStatus (S3D-33)", () => {
  it("names every state in customer words", () => {
    const label = (o: Partial<Conversion>) => runStatus(run(o)).label;
    expect(label({ state: "created" })).toBe("Confirming payment");
    expect(label({ state: "paid" })).toBe("Waiting in line");
    expect(label({ state: "processing", waiting_for_gpu: true })).toBe("Waiting in line");
    expect(label({ state: "processing" })).toBe("Making your 3D");
    expect(label({ state: "succeeded" })).toBe("Ready");
    expect(
      label({ state: "succeeded", billing: { status: "charge_failed" } }),
    ).toBe("Ready, payment needed");
    expect(label({ state: "failed" })).toBe("Failed, not charged");
    expect(
      label({
        state: "failed",
        charge_timing: "before",
        billing: { status: "refunded", charged_cents: 3000 },
      }),
    ).toBe("Failed, refunded $30.00");
    expect(label({ state: "canceled" })).toBe("Cancelled, not charged");
    expect(label({ state: "expired" })).toBe("Didn't start, not charged");
  });
});

describe("one time format (S3D-34)", () => {
  it("reads 'about N min' everywhere", () => {
    expect(formatDuration(42)).toBe("about 40 s");
    expect(formatDuration(12 * 60 + 10)).toBe("about 12 min");
    expect(formatDuration(65 * 60)).toBe("about 1 h 5 min");
    expect(formatTimeLeft(12 * 60)).toBe("about 12 min left");
    expect(formatVideoLength(312)).toBe("5 min 12 s");
    expect(formatVideoLength(3840)).toBe("1 h 4 min");
  });
});
