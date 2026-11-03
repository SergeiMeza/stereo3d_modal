import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ProScreen } from "@/components/pro/ProScreen";
import { stepCheckoutAtom } from "@/components/steps/checkoutStore";
import type { StepQuoteResponse } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { resetProForTests, useProOffer } from "@/lib/pro/usePro";
import { server } from "@/mocks/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/pro",
  useSearchParams: () => new URLSearchParams("next=/projects/abc123abc123"),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetProForTests();
});
afterAll(() => server.close());

function Offer() {
  const offer = useProOffer();
  return <p data-testid="offer">{offer?.line ?? "none"}</p>;
}

describe("/pro (mock mode)", () => {
  it("shows the plans, Weekly first and chosen", async () => {
    render(
      <AuthProvider>
        <ProScreen />
      </AuthProvider>,
    );
    expect(await screen.findByTestId("pro-plans")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/% off every 3D video$/);
    const weekly = screen.getByTestId("pro-plan-weekly");
    expect(weekly.getAttribute("aria-checked")).toBe("true");
    expect(weekly.textContent).toContain("$3.99 / week for 4 weeks");
    expect(screen.getByTestId("pro-plan-yearly").textContent).toContain("Save 26%");
    fireEvent.click(screen.getByTestId("pro-plan-pass"));
    expect(screen.getByText("3 months of Pro. Doesn't renew.")).toBeTruthy();
  });

  it("buys, says welcome, links back to the video and drops stale quotes", async () => {
    const store = getDefaultStore();
    const a = stepCheckoutAtom("abc123abc123", "stereo_preview", "lifelike");
    store.set(a, {
      quote: { quote: { amount_cents: 850 } } as unknown as StepQuoteResponse,
      attemptKey: "k",
      active: null,
      settled: false,
    });
    render(
      <AuthProvider>
        <ProScreen />
      </AuthProvider>,
    );
    fireEvent.click(await screen.findByTestId("pro-get"));
    expect(await screen.findByTestId("pro-member")).toBeTruthy();
    expect(screen.getByText("Welcome to Pro")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to your video" }).getAttribute("href")).toBe(
      "/projects/abc123abc123",
    );
    await waitFor(() => expect(store.get(a).quote).toBeNull());
    expect(store.get(a).attemptKey).toBeNull();
  });

  it("useProOffer anchors on Monthly for the quote's sheet", async () => {
    render(
      <AuthProvider>
        <Offer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("offer").textContent).toBe("$8.99 a month"));
  });
});
