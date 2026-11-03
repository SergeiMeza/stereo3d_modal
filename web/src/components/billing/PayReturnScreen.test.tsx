/**
 * P4 Return page (spec v6 G2): a run paid on another page comes back as
 * Paid; a refused one as Not paid; a settle as "Your downloads are back."
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { PayReturnScreen } from "./PayReturnScreen";

const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function seedRun(state: "paid" | "created"): string {
  const id = "cret00000001";
  mockDb.conversions.set(id, {
    conversion_id: id,
    state,
    kind: "video",
    project_id: "a1b2c3d4e5f6",
    step: "production",
    params: { preset: "1080p", formats: ["sbs"] },
    quote: { amount_cents: 675, currency: "usd" },
    progress: 0,
    created_at: "2026-11-03T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
  });
  return id;
}

describe("Return page (P4)", () => {
  it("a paid run: Payment received, back to the project", async () => {
    const id = seedRun("paid");
    search.value = `conversion=${id}&project=a1b2c3d4e5f6`;
    render(
      <AuthProvider>
        <PayReturnScreen />
      </AuthProvider>,
    );
    expect(await screen.findByText("Payment received. Your 3D video is starting.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to your project" }).getAttribute("href")).toBe(
      "/projects/a1b2c3d4e5f6#tab=make",
    );
  });

  it("a refused redirect: The payment didn't go through, with Try again", async () => {
    const id = seedRun("created");
    search.value = `conversion=${id}&project=a1b2c3d4e5f6&redirect_status=failed`;
    render(
      <AuthProvider>
        <PayReturnScreen />
      </AuthProvider>,
    );
    expect(screen.getByText("The payment didn't go through.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Choose another way to pay" })).toBeTruthy();
  });

  it("a settle: Paid. Your downloads are back.", async () => {
    search.value = "settle=1";
    render(
      <AuthProvider>
        <PayReturnScreen />
      </AuthProvider>,
    );
    expect(await screen.findByText("Paid. Your downloads are back.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Stereo3D Studio" })).toBeTruthy();
  });
});
