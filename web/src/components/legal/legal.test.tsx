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
  });
});

describe("TermsPage", () => {
  it("renders the terms with the binding-quote billing promise", () => {
    render(<TermsPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Terms of Use" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/only charged for jobs that complete successfully/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toBeTruthy();
  });
});
