import { describe, expect, it } from "vitest";

import type { Conversion } from "@/lib/api/types";
import { formatDuration, formatTimeLeft, formatVideoLength } from "@/lib/format";

import { cancelable, cancelSecondsLeft } from "./ConversionTracker";
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

describe("cancel window (S3D-23)", () => {
  const now = Date.parse("2026-11-03T10:00:00Z");
  const started = (secondsAgo: number): Conversion =>
    run({
      state: "processing",
      cancelable_until: new Date(now + (60 - secondsAgo) * 1000).toISOString(),
    });

  it("any time while waiting in line, then for 1 minute after the start", () => {
    expect(cancelable(run({ state: "paid" }), now)).toBe(true);
    expect(
      cancelable(
        run({
          state: "processing",
          waiting_for_gpu: true,
          cancelable_until: new Date(now - 5000).toISOString(),
        }),
        now,
      ),
    ).toBe(true);
    expect(cancelable(started(18), now)).toBe(true);
    expect(cancelSecondsLeft(started(18), now)).toBe(42);
    expect(cancelable(started(61), now)).toBe(false);
    expect(cancelSecondsLeft(started(61), now)).toBeNull();
    expect(cancelable(run({ state: "succeeded" }), now)).toBe(false);
  });

  it("a cancelled pre-paid run reads refunded", () => {
    expect(
      runStatus(
        run({
          state: "canceled",
          charge_timing: "before",
          billing: { status: "refunded", charged_cents: 4500 },
        }),
      ).label,
    ).toBe("Cancelled, refunded $45.00");
  });
});
