/**
 * D7 (owner 2026-11-07, final contract): the pay page a failed payment's
 * mail links to (/pay/{token}). Signed out it shows what it's for and the
 * amount (no email); Pay opens our payment form (a step-up's today's
 * amount too) or goes to a renewal's hosted invoice; paid, void, expired,
 * a payment already going and unknown links say so.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { PayRequest } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { PayRequestPage, setPayRequestNavigateForTests, setPayRequestPollForTests } from "./PayRequestPage";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  mockDb.reset();
  setPayRequestPollForTests({});
  window.history.replaceState(null, "", "/");
});
afterAll(() => server.close());

function request(token: string, over: Partial<PayRequest> & { flow?: "checkout" | "url"; inProgress?: boolean; todayCents?: number } = {}): void {
  mockDb.payRequests.set(token, {
    amount_cents: 2500,
    currency: "usd",
    label: "Auto-reload · Nov 7",
    state: "open",
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
    const bodies: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "POST" && request.url.endsWith("/checkout")) bodies.push(await request.clone().json());
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
    expect(bodies[0]).toEqual({ ui: "elements", return_url: `${window.location.origin}/pay/tok_topup` });
    expect(asked.filter((a) => a.includes("/v1/pay-requests/"))).toEqual([
      "GET /v1/pay-requests/tok_topup anon",
      "POST /v1/pay-requests/tok_topup/checkout anon",
    ]);
  });

  it("a wallet (Apple Pay, Google Pay) pays in the page through the same result path (BUX-03)", async () => {
    request("tok_wallet");
    page("tok_wallet");
    fireEvent.click(await screen.findByTestId("pay-request-pay"));
    fireEvent.click(await screen.findByTestId("mock-wallet"));
    expect(await screen.findByText("Paid. Thank you.")).toBeTruthy();
    expect(mockDb.payRequests.get("tok_wallet")!.state).toBe("paid");
  });

  it("a declined wallet keeps the form and its Pay button", async () => {
    request("tok_wallet_no");
    mockDb.billing.nextConfirm = "declined";
    page("tok_wallet_no");
    fireEvent.click(await screen.findByTestId("pay-request-pay"));
    fireEvent.click(await screen.findByTestId("mock-wallet"));
    expect(await screen.findByTestId("pay-request-notice")).toBeTruthy();
    expect((screen.getByTestId("pay-request-confirm") as HTMLButtonElement).disabled).toBe(false);
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
    request("tok_invoice", { flow: "url", label: "Business plan · monthly" });
    const go = vi.fn();
    setPayRequestNavigateForTests(go);
    page("tok_invoice");
    await screen.findByTestId("pay-request-pay");
    fireEvent.click(screen.getByTestId("pay-request-pay"));
    await waitFor(() => expect(go).toHaveBeenCalledWith("https://invoice.stripe.com/i/mock/tok_invoice"));
  });

  it("a step-up pays today's amount through our form (the gateway then applies the change)", async () => {
    request("tok_stepup", { label: "Business → Studio", amount_cents: 70000, todayCents: 64250 });
    page("tok_stepup");
    expect((await screen.findByTestId("pay-request-amount")).textContent).toBe("$700.00");
    fireEvent.click(screen.getByTestId("pay-request-pay"));
    // the amount the checkout names now
    expect((await screen.findByTestId("pay-request-confirm")).textContent).toBe("Pay $642.50");
    expect(screen.getByTestId("pay-request-amount").textContent).toBe("$642.50");
    fireEvent.click(screen.getByTestId("pay-request-confirm"));
    expect(await screen.findByText("Paid. Thank you.")).toBeTruthy();
  });

  it("a payment already going says so and keeps Pay", async () => {
    request("tok_busy", { inProgress: true });
    page("tok_busy");
    fireEvent.click(await screen.findByTestId("pay-request-pay"));
    expect((await screen.findByTestId("pay-request-notice")).textContent).toBe(
      "A payment is already in progress. Try again in a minute.",
    );
    expect(screen.getByTestId("pay-request-pay")).toBeTruthy();
  });

  it("a link closed while the page was open (409 pay_link_closed) shows its state", async () => {
    request("tok_late");
    page("tok_late");
    await screen.findByTestId("pay-request-pay");
    mockDb.payRequests.get("tok_late")!.state = "void";
    fireEvent.click(screen.getByTestId("pay-request-pay"));
    expect(await screen.findByText("This payment isn't needed any more.")).toBeTruthy();
  });

  it("checkout answering already paid reads as paid", async () => {
    request("tok_done");
    page("tok_done");
    await screen.findByTestId("pay-request-pay");
    mockDb.payRequests.get("tok_done")!.state = "paid";
    fireEvent.click(screen.getByTestId("pay-request-pay"));
    expect(await screen.findByText("Paid. Thank you.")).toBeTruthy();
  });

  it("too many tries (429) says so", async () => {
    request("tok_many");
    server.use(http.post(`${GATEWAY}/v1/pay-requests/:token/checkout`, () => HttpResponse.json({ error: "rate_limited", message: "slow down" }, { status: 429 })));
    page("tok_many");
    fireEvent.click(await screen.findByTestId("pay-request-pay"));
    expect((await screen.findByTestId("pay-request-notice")).textContent).toBe("Too many tries. Wait a minute.");
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

describe("the pay page after a payment that's still being confirmed (REV-06)", () => {
  function returnedTo(token: string, query: string): void {
    window.history.replaceState(null, "", `/pay/${token}?${query}`);
  }

  it("back with ?done=1 before the webhook: Processing…, no Pay, then Paid once the link closes", async () => {
    setPayRequestPollForTests({ fastMs: 20 });
    request("tok_back");
    returnedTo("tok_back", "done=1&redirect_status=succeeded");
    page("tok_back");
    expect((await screen.findByTestId("pay-request-processing")).textContent).toBe("Processing…");
    expect(screen.queryByTestId("pay-request-pay")).toBeNull();
    expect(document.body.textContent).not.toContain("Paid. Thank you.");
    mockDb.payRequests.get("tok_back")!.state = "paid";
    expect(await screen.findByText("Paid. Thank you.")).toBeTruthy();
  });

  it("a redirect_status of processing waits the same way", async () => {
    setPayRequestPollForTests({ fastMs: 20 });
    request("tok_bank");
    returnedTo("tok_bank", "done=1&redirect_status=processing");
    page("tok_bank");
    await screen.findByTestId("pay-request-processing");
    expect(screen.queryByTestId("pay-request-pay")).toBeNull();
  });

  it("still open after a while: says it's being confirmed, still with no Pay", async () => {
    setPayRequestPollForTests({ fastMs: 10, slowAfterMs: 0, slowMs: 10 });
    request("tok_slow");
    returnedTo("tok_slow", "done=1");
    page("tok_slow");
    expect(await screen.findByText("Your payment is being confirmed. This page updates when it's done.")).toBeTruthy();
    expect(screen.queryByTestId("pay-request-pay")).toBeNull();
  });

  it("redirect_status=failed shows the decline beside Pay", async () => {
    request("tok_failed");
    returnedTo("tok_failed", "done=1&redirect_status=failed");
    page("tok_failed");
    expect((await screen.findByTestId("pay-request-notice")).textContent).toBe(
      "Your payment method was declined. Try another way to pay.",
    );
    expect(screen.getByTestId("pay-request-pay")).toBeTruthy();
  });

  it("a hosted page's cancel (canceled=1) is the plain page with Pay", async () => {
    request("tok_cancel");
    returnedTo("tok_cancel", "done=1&canceled=1");
    page("tok_cancel");
    expect(await screen.findByTestId("pay-request-pay")).toBeTruthy();
    expect(screen.queryByTestId("pay-request-notice")).toBeNull();
  });

  it("the form answering processing reads Processing…, not Paid", async () => {
    setPayRequestPollForTests({ fastMs: 20 });
    request("tok_form_proc");
    mockDb.billing.nextConfirm = "processing";
    page("tok_form_proc");
    fireEvent.click(await screen.findByTestId("pay-request-pay"));
    fireEvent.click(await screen.findByTestId("pay-request-confirm"));
    expect(await screen.findByTestId("pay-request-processing")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Paid. Thank you.");
    expect(screen.queryByTestId("pay-request-confirm")).toBeNull();
    mockDb.payRequests.get("tok_form_proc")!.state = "paid";
    expect(await screen.findByText("Paid. Thank you.")).toBeTruthy();
  });
});
