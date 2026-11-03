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
  it("shows both tables from GET /v1/pricing, concise, with one charging line", async () => {
    render(
      <AuthProvider>
        <PricingScreen />
      </AuthProvider>,
    );
    const lifelike = await screen.findByTestId("pricing-lifelike");
    expect(within(lifelike).getByText("Recommended")).toBeTruthy();
    expect(lifelike.textContent).toContain("from $4.50 a minute");
    expect(lifelike.textContent).toContain("4K3840×2160 per eye$10.00");
    expect(lifelike.textContent).toContain("Any length, up to 8K · previews from $0.50");
    const classic = screen.getByTestId("pricing-classic");
    expect(within(classic).getByText("Older method")).toBeTruthy();
    expect(classic.textContent).toContain("$27.46");
    expect(classic.textContent).toContain("Up to 10 minutes, up to 4K");
    expect(screen.getByTestId("pricing-charge-line").textContent).toBe(
      "Charged after it's done. Runs over $25 are charged when they start and refunded if they fail.",
    );
    // no worked examples, no balance wording
    expect(document.body.textContent).not.toMatch(/balance|example/i);
    fireEvent.click(screen.getByRole("button", { name: "How pricing works" }));
    expect(screen.getByRole("dialog").textContent).toContain("10% off");
  });
});
