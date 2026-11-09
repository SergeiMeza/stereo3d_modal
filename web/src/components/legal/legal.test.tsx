/**
 * Smoke tests for the static legal pages — they're pure server components
 * with no providers, so a bare render covers "the route won't 500" plus
 * the load-bearing claims staying present.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";

afterEach(cleanup);

describe("PrivacyPage", () => {
  it("renders the policy with its core commitments", () => {
    render(<PrivacyPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Privacy Policy" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/We do not use your videos to train/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Terms of Use" })).toBeTruthy();
    expect(screen.getByText(/RevenueCat/, { selector: "p" })).toBeTruthy();
    const text = document.body.textContent ?? "";
    // owner 2026-11-04: no Google Analytics, provenance, regions
    expect(text).not.toMatch(/Google Analytics/);
    expect(text).toContain("content credentials");
    expect(text).toContain("regional relays");
    expect(text).toContain("Effective 1 November 2026");
  });
});

describe("TermsPage", () => {
  it("renders the terms with the quote promise and the commercial-use rule", () => {
    render(<TermsPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Terms of Use" }),
    ).toBeTruthy();
    expect(screen.getByText(/that is the most you are/)).toBeTruthy();
    expect(screen.getByText(/each started minute/)).toBeTruthy();
    expect(screen.getByText(/All other outputs are for personal, non-commercial use/)).toBeTruthy();
    // owner 2026-11-09: Commercial use is an add-on; plans active that day
    // keep it until their next renewal
    expect(screen.getByText(/Outputs of runs bought with the Commercial use add-on may be\s+used commercially/)).toBeTruthy();
    expect(screen.getByText(/includes Commercial use until its next\s+renewal/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Classic|\bbeta\b/i);
    expect(document.body.textContent).toContain("Notice and takedown");
    expect(document.body.textContent).toContain("content credentials");
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toBeTruthy();
  });

  it("has the refunds anchor the pay sheet links to (BUX-19)", () => {
    render(<TermsPage />);
    const section = document.getElementById("refunds");
    expect(section?.textContent).toContain("If nothing is delivered, you are refunded.");
  });
});
