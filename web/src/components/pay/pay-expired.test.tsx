/**
 * Staging 2026-11-05: the run's payment expired as Pay was pressed and the
 * sheet stayed on "Paying…". An expired, canceled or completed session is
 * never a decline, the polled run ends the wait, and a confirm that never
 * answers re-checks the run after a minute.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Conversion } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { applyRun } from "@/lib/live/liveStore";
import { appStore } from "@/lib/state/stores";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { confirmErrorResult, confirmSuccessResult } from "./CheckoutPane";
import { CONFIRM_TIMEOUT_MS, PaySheet, runPayOutcome } from "./PaySheet";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const SECRET = "cs_mock_run_cexp00000001_abc123";

function waitingRun(): Conversion {
  const c: Conversion = {
    conversion_id: "cexp00000001",
    state: "created",
    kind: "video",
    project_id: "a1b2c3d4e5f6",
    step: "production",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: { amount_cents: 4972, currency: "usd" },
    progress: 0,
    billing: {
      status: "requires_payment",
      reason: "no_method",
      checkout: { client_secret: SECRET, expires_at: new Date(Date.now() + 60_000).toISOString() },
    },
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:00:00Z",
  };
  mockDb.conversions.set(c.conversion_id, c);
  mockDb.billing.checkouts.set(SECRET, {
    kind: "run",
    conversion_id: c.conversion_id,
    amount_cents: 4972,
    state: "open",
    expires_at: c.billing!.checkout!.expires_at,
  });
  return c;
}

/** The mock's confirm hangs, like a Stripe confirm that never answers. */
function hangConfirm(): void {
  server.use(http.post(`${GATEWAY}/__mock__/checkout/:secret/confirm`, async () => {
    await delay("infinite");
    return HttpResponse.json({});
  }));
}

function sheet(run: Conversion, onClose = vi.fn()) {
  const ui = (r: Conversion) => (
    <AuthProvider>
      <PaySheet
        conversionId={r.conversion_id}
        amountCents={r.quote.amount_cents}
        action="Make 3D"
        billing={r.billing}
        run={r}
        onClose={onClose}
      />
    </AuthProvider>
  );
  const view = render(ui(run));
  return { ...view, update: (r: Conversion) => view.rerender(ui(r)), onClose };
}

describe("Stripe Checkout confirm results", () => {
  it("an expired, canceled or completed session is not a decline", () => {
    expect(confirmErrorResult({ code: null, message: "This Checkout Session has expired." })).toBe("expired");
    expect(confirmErrorResult({ code: null, message: "This Checkout Session is no longer active." })).toBe("expired");
    expect(confirmErrorResult({ code: null, message: "This session was canceled." })).toBe("expired");
    expect(confirmErrorResult({ code: null, message: "This Checkout Session has already been completed." })).toBe(
      "already_paid",
    );
    // the session's own status wins over the words
    expect(confirmErrorResult({ code: null, message: "Something went wrong." }, { type: "expired" })).toBe("expired");
    expect(
      confirmErrorResult({ code: null, message: "Something went wrong." }, { type: "complete", paymentStatus: "paid" }),
    ).toBe("already_paid");
  });

  it("a real decline stays a decline, even an expired card", () => {
    expect(confirmErrorResult({ code: "paymentFailed", message: "Your card has expired." }, { type: "open" })).toBe(
      "declined",
    );
    expect(confirmErrorResult({ code: null, message: "Your card number is incomplete." })).toBe("declined");
  });

  it("a confirm that answers with an expired session shows expired", () => {
    expect(confirmSuccessResult({ type: "expired" })).toBe("expired");
    expect(confirmSuccessResult({ type: "complete", paymentStatus: "paid" })).toBe("paid");
    expect(confirmSuccessResult({ type: "complete", paymentStatus: "unpaid" })).toBe("processing");
  });

  it("reads the run", () => {
    expect(runPayOutcome({ state: "expired" })).toBe("expired");
    expect(runPayOutcome({ state: "canceled" })).toBe("expired");
    expect(runPayOutcome({ state: "paid" })).toBe("paid");
    expect(runPayOutcome({ state: "processing" })).toBe("paid");
    expect(runPayOutcome({ state: "created", billing: { status: "waiting_for_payment" } })).toBe("waiting");
    expect(runPayOutcome({ state: "created", billing: { status: "requires_payment" } })).toBeNull();
  });
});

describe("the run pay sheet never spins", () => {
  it("an expired session at confirm shows expired with Start again", async () => {
    const run = waitingRun();
    mockDb.billing.checkouts.get(SECRET)!.state = "expired";
    sheet(run);
    fireEvent.click(await screen.findByTestId("pay-main"));
    expect(await screen.findByTestId("pay-expired")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy();
  });

  it("a run that expires while paying shows expired", async () => {
    hangConfirm();
    const run = waitingRun();
    const s = sheet(run);
    fireEvent.click(await screen.findByTestId("pay-main"));
    await waitFor(() => expect(screen.getByTestId("pay-main").textContent).toContain("Paying"));
    s.update({ ...run, state: "expired" });
    expect(await screen.findByTestId("pay-expired")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy();
  });

  it("a run that's paid while paying finishes and closes", async () => {
    hangConfirm();
    const run = waitingRun();
    const s = sheet(run);
    fireEvent.click(await screen.findByTestId("pay-main"));
    await waitFor(() => expect(screen.getByTestId("pay-main").textContent).toContain("Paying"));
    s.update({ ...run, state: "processing", billing: { status: "charged" } });
    expect(await screen.findByTestId("pay-success")).toBeTruthy();
    await waitFor(() => expect(s.onClose).toHaveBeenCalledWith("paid"), { timeout: 3000 });
  });

  it("a run the live feed says expired, while the confirm hangs, shows expired (owner 2026-11-07)", async () => {
    hangConfirm();
    const run = waitingRun();
    sheet(run);
    fireEvent.click(await screen.findByTestId("pay-main"));
    await waitFor(() => expect(screen.getByTestId("pay-main").textContent).toContain("Paying"));
    // the gateway expired the run meanwhile; the sheet's own prop is stale,
    // the live feed isn't
    act(() => {
      applyRun(appStore, { ...run, state: "expired", updated_at: "2026-11-05T00:01:00Z" });
    });
    expect(await screen.findByTestId("pay-expired")).toBeTruthy();
  });

  it("a re-check that finds the run still waiting gives the button back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    hangConfirm();
    const run = waitingRun();
    sheet(run);
    fireEvent.click(await screen.findByTestId("pay-main"));
    await waitFor(() => expect(screen.getByTestId("pay-main").textContent).toContain("Paying"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 10);
    });
    await waitFor(() => expect(screen.getByTestId("pay-main").textContent).not.toContain("Paying"));
    expect((screen.getByTestId("pay-main") as HTMLButtonElement).disabled).toBe(false);
  });
});
