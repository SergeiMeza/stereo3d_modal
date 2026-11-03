import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { LandingContent } from "./LandingContent";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

describe("Landing hero (mock 12, S3D-46)", () => {
  it("leads with Lifelike 3D and takes its prices from GET /v1/pricing", async () => {
    render(
      <AuthProvider>
        <LandingContent />
      </AuthProvider>,
    );
    expect(screen.getByTestId("hero-eyebrow").textContent).toBe(
      "Lifelike 3D · our newest 3D technology",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Turn any video into lifelike 3D",
    );
    expect(
      screen.getByRole("link", { name: "Make your first 3D video" }),
    ).toBeTruthy();
    expect((await screen.findByTestId("hero-from-price")).textContent).toBe(
      "from $3 a minute",
    );
    expect(screen.getByTestId("hero-step-2").textContent).toBe(
      "A few seconds in 3D, from $1.",
    );
    // Works with, text only, each linking to its page (S3D-51)
    const works = screen.getByTestId("works-with");
    expect(works.textContent).toContain(
      "Works withApple Vision ProSamsung Galaxy XRMeta QuestPicoSteam FrameXR glasses",
    );
    expect(works.textContent).toContain("Ready for Meta VR Glasses (spring 2027)");
    // no technical words on the page
    expect(document.body.textContent).not.toMatch(
      /splat|gaussian|depth map|warp|inpaint|model/i,
    );
  });
});
