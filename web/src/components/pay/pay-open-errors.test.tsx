/**
 * BUX-05: a pay sheet that couldn't open its payment names the problem
 * (connection, server, decline, region) and offers Try again where it can
 * help. The region line is only for an explicit region refusal.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GatewayError } from "@/lib/api/client";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { PaySheet, payOpenError } from "./PaySheet";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const REGION = "Payment isn't available in this region yet.";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function sheet(): void {
  render(
    <AuthProvider>
      <PaySheet conversionId="cerr00000001" amountCents={1200} action="Make 3D" onClose={vi.fn()} />
    </AuthProvider>,
  );
}

const payNow = `${GATEWAY}/v1/conversions/:id/pay-now`;

describe("why a payment couldn't be opened (BUX-05)", () => {
  it("maps each failure to what the customer can do", () => {
    expect(payOpenError(new TypeError("Failed to fetch"))).toBe("network");
    expect(payOpenError(new GatewayError("payment_error", "x", 502))).toBe("server");
    expect(payOpenError(new GatewayError("payment_unavailable", "x", 503))).toBe("server");
    expect(payOpenError(new GatewayError("server_error", "x", 500))).toBe("server");
    expect(payOpenError(new GatewayError("card_declined", "x", 402))).toBe("declined");
    expect(payOpenError(new GatewayError("payment_method_blocked", "x", 403))).toBe("declined");
    expect(payOpenError(new GatewayError("region_unavailable", "x", 403))).toBe("region");
    expect(payOpenError(new GatewayError("china_payments_unavailable", "x", 403))).toBe("china");
    expect(payOpenError(new GatewayError("not_payable", "x", 409))).toBe("not_payable");
  });

  it("no connection: says so, and Try again opens it", async () => {
    server.use(http.post(payNow, () => HttpResponse.error(), { once: true }));
    sheet();
    expect((await screen.findByTestId("pay-unavailable")).textContent).toBe(
      "We couldn't open the payment. Check your connection and try again.",
    );
    expect(screen.queryByText(REGION)).toBeNull();
    server.use(
      http.post(payNow, () =>
        HttpResponse.json({
          checkout: { client_secret: "cs_mock_run_cerr00000001_x", expires_at: new Date(Date.now() + 600_000).toISOString() },
          amount_cents: 1200,
        }),
      ),
    );
    fireEvent.click(screen.getByTestId("pay-try-again"));
    expect(await screen.findByTestId("pay-main")).toBeTruthy();
  });

  it("a server failure: try again in a moment", async () => {
    server.use(http.post(payNow, () => HttpResponse.json({ error: "payment_error", message: "x" }, { status: 502 })));
    sheet();
    expect((await screen.findByTestId("pay-unavailable")).textContent).toBe(
      "We couldn't open the payment. Try again in a moment.",
    );
    expect(screen.getByTestId("pay-try-again")).toBeTruthy();
  });

  it("an explicit region refusal keeps the region line, with no Try again", async () => {
    server.use(http.post(payNow, () => HttpResponse.json({ error: "region_unavailable", message: "x" }, { status: 403 })));
    sheet();
    expect((await screen.findByTestId("pay-unavailable")).textContent).toBe(REGION);
    expect(screen.queryByTestId("pay-try-again")).toBeNull();
  });

  it("a payment the bank is confirming already: waiting, not an error", async () => {
    server.use(http.post(payNow, () => HttpResponse.json({ error: "payment_in_progress", message: "x" }, { status: 409 })));
    sheet();
    expect(await screen.findByTestId("pay-waiting")).toBeTruthy();
  });
});
