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
    expect(document.body.textContent).not.toMatch(/Classic/);
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toBeTruthy();
  });
});
