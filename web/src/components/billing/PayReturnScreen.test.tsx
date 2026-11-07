/**
 * P4 Return page (spec v6 G2): a run paid on another page comes back as
 * Paid; a refused one as Not paid; a settle as "Your downloads are back."
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { PayReturnScreen, TOPUP_WINDOW_MS, topupEntry } from "./PayReturnScreen";

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

  it("the gateway's return address (?c=): finds the run and its project", async () => {
    const id = seedRun("paid");
    search.value = `c=${id}`;
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
    expect(screen.getByRole("link", { name: "Back to Spatial Video Studio" })).toBeTruthy();
  });
});

describe("Return page: a top-up (BUX-04, China's Alipay)", () => {
  function renderPage(): void {
    render(
      <AuthProvider>
        <PayReturnScreen />
      </AuthProvider>,
    );
  }

  it("paid: Added $25.00. Your balance is $28.20., back to Billing", async () => {
    const pp = mockDb.billing.prepaid;
    pp.balance_cents = 2820;
    pp.entries.push({ id: "e1", kind: "topup", cents: 2500, at: new Date().toISOString() });
    search.value = "topup=1&amount=2500&payment_intent=pi_1&redirect_status=succeeded";
    renderPage();
    expect(await screen.findByText("Added $25.00. Your balance is $28.20.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Billing" }).getAttribute("href")).toBe("/account/billing");
    expect(screen.queryByText("The payment didn't go through.")).toBeNull();
  });

  it("before the ledger has it: still checking, never Not paid", async () => {
    search.value = "topup=1&amount=2500&redirect_status=succeeded";
    renderPage();
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByTestId("pay-return").getAttribute("data-state")).toBe("checking");
  });

  it("a refused redirect: The payment didn't go through, back to Billing", () => {
    search.value = "topup=1&amount=2500&redirect_status=failed";
    renderPage();
    expect(screen.getByText("The payment didn't go through.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/account/billing");
  });

  it("finds this top-up's row: newest, of this amount, not an old one", () => {
    const now = Date.parse("2026-11-07T10:00:00Z");
    const at = (ms: number) => new Date(now + ms).toISOString();
    const rows = [
      { id: "old", kind: "topup" as const, cents: 2500, at: at(-TOPUP_WINDOW_MS - 1000) },
      { id: "auto", kind: "auto_reload" as const, cents: 2500, at: at(5000) },
      { id: "other", kind: "topup" as const, cents: 5000, at: at(3000) },
      { id: "this", kind: "topup" as const, cents: 2500, at: at(2000) },
    ];
    expect(topupEntry(rows, 2500, now)?.id).toBe("this");
    expect(topupEntry(rows, null, now)?.id).toBe("other");
    expect(topupEntry(rows.slice(0, 2), 2500, now)).toBeNull();
  });

  it("REV-14: with the top-up's id, its own row and no other", () => {
    const now = Date.parse("2026-11-07T10:00:00Z");
    const at = (ms: number) => new Date(now + ms).toISOString();
    const rows = [
      { id: "newer", kind: "topup" as const, cents: 2500, at: at(5000), topup_id: "tu_card" },
      { id: "mine", kind: "topup" as const, cents: 2500, at: at(1000), topup_id: "tu_redirect" },
    ];
    expect(topupEntry(rows, 2500, now, "tu_redirect")?.id).toBe("mine");
    // ids on the rows, this one not landed: none (never another's)
    expect(topupEntry(rows.slice(0, 1), 2500, now, "tu_redirect")).toBeNull();
    // rows without ids (an older gateway): the window as before
    expect(topupEntry([{ id: "old", kind: "topup" as const, cents: 2500, at: at(1000) }], 2500, now, "tu_x")?.id).toBe("old");
  });

  it("REV-14: a card top-up then an abandoned one: the return names its own, not the newest", async () => {
    const pp = mockDb.billing.prepaid;
    pp.balance_cents = 2820;
    pp.entries.push({ id: "e1", kind: "topup", cents: 2500, at: new Date().toISOString(), topup_id: "tu_card" });
    search.value = "topup=tu_abandoned&amount=2500&redirect_status=succeeded";
    renderPage();
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByTestId("pay-return").getAttribute("data-state")).toBe("checking");
    expect(screen.queryByText(/Added \$25\.00/)).toBeNull();
    cleanup();
    search.value = "topup=tu_card&amount=2500&redirect_status=succeeded";
    renderPage();
    expect(await screen.findByText("Added $25.00. Your balance is $28.20.")).toBeTruthy();
  });
});
