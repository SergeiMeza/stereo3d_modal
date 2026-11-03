import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { PricingScreen } from "./PricingScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pricing",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

describe("Pricing page (S3D-18, S3D-45)", () => {
  it("shows Lifelike's table from GET /v1/pricing, concise, with one charging line (S3D-01, S3D-11)", async () => {
    render(
      <AuthProvider>
        <PricingScreen />
      </AuthProvider>,
    );
    const lifelike = await screen.findByTestId("pricing-lifelike");
    expect(within(lifelike).getByText("New")).toBeTruthy();
    // headline in whole dollars, table in cents
    expect(lifelike.textContent).toContain("from $3 a minute at 24 fps");
    expect(lifelike.textContent).toContain("Per minute, 24 fps");
    expect(screen.getByTestId("pricing-fps-rule").textContent).toBe(
      "30 fps +25% · 60 fps ×2.5",
    );
    expect(lifelike.textContent).toContain("1080p1920×1080 per eye$3.00");
    expect(lifelike.textContent).toContain("4K3840×2160 per eye$8.50");
    expect(lifelike.textContent).toContain("8K7680×4320 per eye$22.00");
    expect(lifelike.textContent).toContain("Any length, up to 8K · previews from $1");
    // no Classic on the public page
    expect(screen.queryByTestId("pricing-classic")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Classic/);
    expect(screen.getByTestId("pricing-charge-line").textContent).toBe(
      "Charged after it's done. Runs over $25 are charged when they start and refunded if they fail.",
    );
    // no worked examples, no balance wording
    expect(document.body.textContent).not.toMatch(/balance|example/i);
    fireEvent.click(screen.getByRole("button", { name: "How pricing works" }));
    expect(screen.getByRole("dialog").textContent).toContain("10% off");
    expect(screen.getByRole("dialog").textContent).toContain("Minimum charge $1 per run.");
  });
});
