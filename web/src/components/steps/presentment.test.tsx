/**
 * Owner 2026-11-07 (Option B, Stripe Adaptive Pricing): a run the card
 * paid in its own currency says so where its price shows — Run details
 * (the Files details Price row) and the runs list — as "Paid ¥1,234
 * ($8.25)"; with no presentment it's US dollars only, as before.
 */
import { describe, expect, it } from "vitest";

import type { Conversion, Project } from "@/lib/api/types";
import { makeTr } from "@/lib/i18n/t";

import projectFixture from "../../../fixtures/project.json";

import { runPrice } from "./PreviousRuns";
import { detailRows } from "./RunDetails";
import { runStatus } from "./runStatus";

const project = projectFixture as unknown as Project;

function run(over: Partial<Conversion> = {}): Conversion {
  return {
    conversion_id: "cjpy00000001",
    state: "succeeded",
    kind: "video",
    project_id: project.project_id,
    step: "production",
    method: "lifelike",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: { amount_cents: 825, currency: "usd" },
    progress: 1,
    outputs: ["mvhevc"],
    billing: { status: "charged", charged_cents: 825 },
    created_at: "2026-11-07T10:00:00Z",
    updated_at: "2026-11-07T10:30:00Z",
    ...over,
  };
}

const price = (c: Conversion, t = makeTr("en", null)) =>
  Object.fromEntries(detailRows(project, c, t).map((r) => [r.id, r.value])).Price;

describe("a run's paid amount in the card's currency", () => {
  it("Run details: \"Paid ¥1,234 ($8.25)\" with a presentment", () => {
    const c = run({ presentment: { amount_minor: 1234, currency: "jpy" } });
    expect(price(c)).toBe("Paid ¥1,234 ($8.25)");
    expect(runPrice(c)).toBe("Paid ¥1,234 ($8.25)");
  });

  it("Run details: US dollars only when presentment is null, absent or USD", () => {
    expect(price(run({ presentment: null }))).toBe("$8.25");
    expect(price(run())).toBe("$8.25");
    expect(price(run({ presentment: { amount_minor: 825, currency: "usd" } }))).toBe("$8.25");
    expect(runPrice(run({ presentment: null }))).toBe("$8.25");
  });

  it("KRW and EUR, and another language's own format", () => {
    expect(price(run({ presentment: { amount_minor: 11000, currency: "krw" } }))).toBe("Paid ₩11,000 ($8.25)");
    expect(price(run({ presentment: { amount_minor: 760, currency: "eur" } }))).toBe("Paid €7.60 ($8.25)");
    const de = makeTr("de", null);
    expect(price(run({ presentment: { amount_minor: 760, currency: "eur" } }), de)).toBe("Paid 7,60 € (8,25 $)");
  });

  it("a run not charged stays \"Not charged\", whatever it carries", () => {
    const c = run({
      state: "failed",
      billing: { status: "not_charged" } as Conversion["billing"],
      presentment: { amount_minor: 1234, currency: "jpy" },
    });
    expect(runPrice(c)).toBe("Not charged");
  });

  it("a refund names the currency the card paid", () => {
    const c = run({
      state: "failed",
      charge_timing: "before",
      billing: { status: "refunded", charged_cents: 825 },
    });
    expect(runStatus(c).label).toContain("$8.25");
    expect(runStatus({ ...c, presentment: { amount_minor: 1234, currency: "jpy" } }).label).toContain("¥1,234");
  });
});
