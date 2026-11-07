/**
 * D7 (owner 2026-11-07): the pay page a failed payment's mail links to
 * (/pay/{token}). Signed out it shows what it's for and the amount (no
 * email); Pay opens our payment form, goes to the hosted invoice, or
 * confirms a step-up with the bank; paid, void and expired links say so.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { PayRequest } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { PayRequestPage, setPayRequestNavigateForTests } from "./PayRequestPage";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  mockDb.reset();
});
afterAll(() => server.close());

function request(token: string, over: Partial<PayRequest> & { flow?: "checkout" | "url" | "requires_action" } = {}): void {
  mockDb.payRequests.set(token, {
    kind: "topup",
    amount_cents: 2500,
    currency: "usd",
    label: "Auto-reload · Nov 7",
    state: "open",
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    flow: "checkout",
    ...over,
  });
}

function page(token: string): void {
  render(
    <AuthProvider>
      <PayRequestPage token={token} />
    </AuthProvider>,
  );
}

describe("the pay page (D7)", () => {
  it("shows what it's for and the amount, never an email, and pays that amount in our form", async () => {
    request("tok_topup");
    const asked: string[] = [];
    server.events.on("request:start", ({ request }) => {
      asked.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get("Authorization") ? "auth" : "anon"}`);
    });
    page("tok_topup");
    expect((await screen.findByTestId("pay-request-label")).textContent).toBe("Auto-reload · Nov 7");
    expect(screen.getByTestId("pay-request-amount").textContent).toBe("$25.00");
    expect(document.body.textContent).not.toMatch(/@/);
    fireEvent.click(screen.getByTestId("pay-request-pay"));
    fireEvent.click(await screen.findByTestId("pay-request-confirm"));
    expect(await screen.findByText("Paid. Thank you.")).toBeTruthy();
    expect(mockDb.payRequests.get("tok_topup")!.state).toBe("paid");
    // public: no sign-in sent with either call
    expect(asked.filter((a) => a.includes("/v1/pay-requests/"))).toEqual([
      "GET /v1/pay-requests/tok_topup anon",
      "POST /v1/pay-requests/tok_topup/checkout anon",
    ]);
  });

  it("a declined payment says so and keeps the form", async () => {
    request("tok_decline");
    mockDb.billing.nextConfirm = "declined";
    page("tok_decline");
    fireEvent.click(await screen.findByTestId("pay-request-pay"));
    fireEvent.click(await screen.findByTestId("pay-request-confirm"));
    expect(await screen.findByTestId("pay-request-notice")).toBeTruthy();
    expect(screen.getByTestId("pay-request-confirm")).toBeTruthy();
  });

  it("an invoice goes to its hosted page", async () => {
    request("tok_invoice", { kind: "invoice", flow: "url", label: "Business plan · monthly" });
    const go = vi.fn();
    setPayRequestNavigateForTests(go);
    page("tok_invoice");
    expect((await screen.findByTestId("pay-request-pay")).parentElement!.textContent).toContain("Charged in US dollars.");
    fireEvent.click(screen.getByTestId("pay-request-pay"));
    await waitFor(() => expect(go).toHaveBeenCalledWith("https://invoice.stripe.com/i/mock/tok_invoice"));
  });

  it("a step-up confirms with the bank (3DS), then reads as paid", async () => {
    request("tok_stepup", { kind: "stepup", flow: "requires_action", label: "Business → Studio" });
    page("tok_stepup");
    fireEvent.click(await screen.findByTestId("pay-request-pay"));
    expect(await screen.findByText("Paid. Thank you.")).toBeTruthy();
    expect(mockDb.payRequests.get("tok_stepup")!.state).toBe("paid");
  });

  it("a step-up the bank doesn't confirm offers the hosted invoice page", async () => {
    request("tok_stepfail", { kind: "stepup", flow: "requires_action" });
    server.use(http.post(`${GATEWAY}/__mock__/complete-3ds`, () => HttpResponse.json({ ok: false }, { status: 402 })));
    page("tok_stepfail");
    fireEvent.click(await screen.findByTestId("pay-request-pay"));
    expect((await screen.findByTestId("pay-request-bank-failed")).textContent).toBe("Your bank didn't confirm the payment.");
    expect(screen.getByTestId("pay-request-invoice").getAttribute("href")).toBe("https://invoice.stripe.com/i/mock/tok_stepfail");
  });

  it.each([
    ["paid", "Paid. Thank you."],
    ["void", "This payment isn't needed any more."],
    ["expired", "This payment link has expired. Sign in and open Billing to pay."],
  ] as const)("a %s link says so, with no Pay", async (state, line) => {
    request(`tok_${state}`, { state });
    page(`tok_${state}`);
    expect(await screen.findByText(line)).toBeTruthy();
    expect(screen.queryByTestId("pay-request-pay")).toBeNull();
  });

  it("an unknown link isn't valid", async () => {
    page("tok_nope");
    expect(await screen.findByText("This payment link isn't valid.")).toBeTruthy();
  });
});
