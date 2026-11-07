/**
 * REV-14: a top-up back on Billing (/account/billing?topup={id}, the
 * gateway's default return) says how that top-up went: checking until
 * its own ledger row lands, then Added; a refused redirect says it didn't
 * go through; a hosted page's cancel says nothing. The query is dropped.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { TopupFromReturn } from "./TopupFromReturn";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  window.history.replaceState(null, "", "/");
});
afterAll(() => server.close());

function at(query: string): void {
  window.history.replaceState(null, "", `/account/billing?${query}`);
  render(
    <AuthProvider>
      <TopupFromReturn />
    </AuthProvider>,
  );
}

describe("a top-up back on Billing (REV-14)", () => {
  it("its own row landed: Added, and the query is dropped", async () => {
    const pp = mockDb.billing.prepaid;
    pp.balance_cents = 4000;
    pp.entries.push({ id: "e1", kind: "topup", cents: 2500, at: new Date().toISOString(), topup_id: "tu_mine" });
    at("topup=tu_mine&redirect_status=succeeded&payment_intent=pi_x");
    expect((await screen.findByText("Added $25.00. Your balance is $40.00.")).getAttribute("data-state")).toBe("added");
    expect(window.location.search).toBe("");
  });

  it("only another top-up's row: still checking", async () => {
    mockDb.billing.prepaid.entries.push({ id: "e1", kind: "topup", cents: 2500, at: new Date().toISOString(), topup_id: "tu_other" });
    at("topup=tu_mine");
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByTestId("topup-return").getAttribute("data-state")).toBe("checking");
    expect(screen.getByTestId("topup-return").textContent).toBe("Checking your payment…");
  });

  it("a refused redirect: it didn't go through", () => {
    at("topup=tu_mine&redirect_status=failed");
    expect(screen.getByTestId("topup-return").textContent).toBe("The payment didn't go through.");
  });

  it("a hosted page's cancel, or no top-up: nothing", () => {
    at("topup=tu_mine&canceled=1");
    expect(screen.queryByTestId("topup-return")).toBeNull();
    cleanup();
    at("tab=methods");
    expect(screen.queryByTestId("topup-return")).toBeNull();
  });
});
