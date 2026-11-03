import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import DevicePageRoute, { generateMetadata } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/devices/galaxy-xr",
  notFound: () => {
    throw new Error("not found");
  },
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

describe("/devices/<slug> (S3D-51, screen 14)", () => {
  it("renders the title, the steps, one button and the price from /v1/pricing", async () => {
    const params = Promise.resolve({ slug: "galaxy-xr" });
    const meta = await generateMetadata({ params });
    expect(meta.title).toBe("Watch 3D videos on Samsung Galaxy XR");
    render(<AuthProvider>{await DevicePageRoute({ params })}</AuthProvider>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Watch 3D videos on Samsung Galaxy XR",
    );
    expect(screen.getByText(/Gallery or Files, then choose 3D side-by-side/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Make your video 3D" })).toBeTruthy();
    expect((await screen.findByTestId("device-price")).textContent).toBe(
      "any length, up to 8K",
    );
    expect(screen.getByText("A Side by side file: one picture for each eye.")).toBeTruthy();
  });
});
