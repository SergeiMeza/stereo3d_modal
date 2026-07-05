import { describe, expect, it } from "vitest";

import { requiresAnalyticsConsent } from "./geoConsent";

describe("requiresAnalyticsConsent", () => {
  it("requires consent in the UK", () => {
    expect(requiresAnalyticsConsent("GB")).toBe(true);
  });

  it("requires consent in EU countries", () => {
    for (const c of ["DE", "FR", "IE", "ES", "SE"]) {
      expect(requiresAnalyticsConsent(c)).toBe(true);
    }
  });

  it("requires consent in non-EU EEA countries", () => {
    for (const c of ["NO", "IS", "LI"]) {
      expect(requiresAnalyticsConsent(c)).toBe(true);
    }
  });

  it("does not require consent elsewhere", () => {
    for (const c of ["US", "JP", "CA", "AU", "BR"]) {
      expect(requiresAnalyticsConsent(c)).toBe(false);
    }
  });

  it("is case-insensitive", () => {
    expect(requiresAnalyticsConsent("gb")).toBe(true);
  });

  it("fails safe (requires consent) when the country is unknown", () => {
    expect(requiresAnalyticsConsent(null)).toBe(true);
    expect(requiresAnalyticsConsent("")).toBe(true);
  });
});
