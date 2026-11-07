/**
 * BUX-20 one-tap pay (owner 2026-11-07): a pay-first run (from its price
 * card) and what the account owes (the settle sheet) paid with one tap on
 * the saved default: "Pay US$37.50 with Visa •••• 4242", Change payment
 * method and Pay another way under it. Each answer (succeeded,
 * processing, requires_action, declined), each refusal (one_tap_unavailable,
 * amount_changed, payment_in_progress, already_paid, expired,
 * not_payable), no double submit, and the sheet when one_tap is null.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LifelikeDeliverPanel } from "@/components/steps/LifelikeDeliverPanel";
import { clearStepQuotes } from "@/components/steps/checkoutStore";
import type { OneTapOffer, Project } from "@/lib/api/types";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { oneTapLabel, oneTapMethodLabel } from "./oneTap";
import { SettleSheet } from "./SettleSheet";
import { makeTr } from "@/lib/i18n/t";

vi.mock("@/components/steps/polling", () => ({ POLL_INTERVAL_MS: 40 }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/projects",
  useSearchParams: () => new URLSearchParams(),
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const PID = (projectFixture as { project_id: string }).project_id;
const EN = makeTr("en", null);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  act(() => clearStepQuotes());
  resetPricingCache();
  mockDb.reset();
});
afterAll(() => server.close());

/** The pay-first world one-tap lives in: deferred payments off, a card. */
function oneTapOn(over: Partial<typeof mockDb.oneTap> = {}): void {
  mockDb.deferredPayments = false;
  mockDb.oneTap = { ...mockDb.oneTap, enabled: true, ...over };
}

/** POSTs to a path, counted. */
function count(pathEnd: string): { n: number } {
  const c = { n: 0 };
  server.events.on("request:start", ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(pathEnd)) c.n += 1;
  });
  return c;
}

function panel(): void {
  const p = mockDb.projects.get(PID)!;
  p.method = "lifelike";
  render(
    <AuthProvider>
      <BillingProvider>
        <LifelikeDeliverPanel project={structuredClone({ ...p, conversions: [] }) as Project} onProjectChanged={() => {}} />
      </BillingProvider>
    </AuthProvider>,
  );
}

async function oneTapButton(): Promise<HTMLButtonElement> {
  return (await screen.findByTestId("one-tap-pay", {}, { timeout: 4000 })) as HTMLButtonElement;
}

/** The run the panel made (the newest). */
function lastRun() {
  return [...mockDb.conversions.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
}

describe("one-tap labels", () => {
  const base: OneTapOffer = { type: "card", brand: "visa", last4: "4242", amount_cents: 375, currency: "usd" };
  it("names the default as the customer knows it, with US dollars marked", () => {
    expect(oneTapLabel(base, EN)).toBe("Pay US$3.75 with Visa •••• 4242");
    expect(oneTapMethodLabel({ ...base, wallet: "apple_pay" })).toBe("Apple Pay");
    expect(oneTapMethodLabel({ ...base, wallet: "google_pay" })).toBe("Google Pay");
    expect(oneTapMethodLabel({ type: "link", email_masked: "a•••@example.com", amount_cents: 375, currency: "usd" })).toBe(
      "Link · a•••@example.com",
    );
    expect(oneTapMethodLabel({ ...base, wallet: "link", email_masked: "a•••@example.com" })).toBe("Link · a•••@example.com");
    expect(oneTapMethodLabel({ type: "paypal", email_masked: "b•••@example.com", amount_cents: 375, currency: "usd" })).toBe(
      "PayPal · b•••@example.com",
    );
    expect(oneTapLabel(base, EN)).not.toMatch(/stripe/i);
  });
});

describe("one-tap on a pay-first run (BUX-20)", () => {
  it("one_tap null: the price card's usual button opens the sheet", async () => {
    mockDb.deferredPayments = false;
    panel();
    const main = await screen.findByTestId("checkout-main", {}, { timeout: 4000 });
    await waitFor(() => expect((main as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("one-tap-pay")).toBeNull();
    fireEvent.click(main);
    expect(await screen.findByTestId("pay-sheet")).toBeTruthy();
  });

  it("succeeded: one tap pays the run, no sheet, no local-price line", async () => {
    mockDb.adaptivePricing = true;
    oneTapOn();
    const taps = count("/pay-one-tap");
    panel();
    const button = await oneTapButton();
    expect(button.textContent).toMatch(/^Pay US\$[\d.,]+ with Visa •••• 4242$/);
    expect(screen.getByTestId("one-tap-change").getAttribute("href")).toBe("/account/billing#payment-methods");
    expect(screen.queryByTestId("quote-local-note")).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(lastRun()?.state).toBe("paid"));
    expect(taps.n).toBe(1);
    expect(screen.queryByTestId("pay-sheet")).toBeNull();
  });

  it("sends the amount the button shows", async () => {
    oneTapOn();
    const bodies: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (new URL(request.url).pathname.endsWith("/pay-one-tap")) bodies.push(await request.clone().json());
    });
    panel();
    fireEvent.click(await oneTapButton());
    await waitFor(() => expect(bodies.length).toBe(1));
    expect(bodies[0]).toEqual({ amount_cents: lastRun().quote.amount_cents });
  });

  it("no double submit: taps while the first is out send one payment", async () => {
    oneTapOn();
    const taps = count("/pay-one-tap");
    const creates = count("/conversions");
    panel();
    const button = await oneTapButton();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(lastRun()?.state).toBe("paid"));
    expect(taps.n).toBe(1);
    expect(creates.n).toBe(1);
  });

  it("processing: says it's being confirmed, the button stays busy", async () => {
    oneTapOn({ outcome: "processing" });
    panel();
    fireEvent.click(await oneTapButton());
    expect((await screen.findByTestId("one-tap-notice")).textContent).toBe("Confirming your payment…");
    expect((screen.getByTestId("one-tap-pay") as HTMLButtonElement).disabled).toBe(true);
  });

  it("requires_action: the bank's check is answered here, then it's paid", async () => {
    oneTapOn({ outcome: "requires_action" });
    const checks = count("/__mock__/one-tap-action");
    panel();
    fireEvent.click(await oneTapButton());
    await waitFor(() => expect(lastRun()?.state).toBe("paid"));
    expect(checks.n).toBe(1);
  });

  it("requires_action the bank refuses: says so, Pay another way opens the sheet for the same run", async () => {
    oneTapOn({ outcome: "requires_action", actionOutcome: "failed" });
    panel();
    fireEvent.click(await oneTapButton());
    expect((await screen.findByTestId("one-tap-notice")).textContent).toBe("We couldn't confirm it with your bank.");
    const run = lastRun();
    expect(run.state).toBe("created");
    fireEvent.click(screen.getByTestId("one-tap-another-way"));
    expect(await screen.findByTestId("pay-sheet")).toBeTruthy();
    expect(lastRun().conversion_id).toBe(run.conversion_id);
  });

  it("declined: the gateway's words, and the tap can be tried again", async () => {
    oneTapOn({ outcome: "declined" });
    const taps = count("/pay-one-tap");
    panel();
    fireEvent.click(await oneTapButton());
    expect((await screen.findByTestId("one-tap-notice")).textContent).toBe("Your card has insufficient funds.");
    const again = screen.getByTestId("one-tap-pay") as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    mockDb.oneTap.outcome = "succeeded";
    fireEvent.click(again);
    await waitFor(() => expect(lastRun()?.state).toBe("paid"));
    // a second tap on the same run (no new run)
    expect(taps.n).toBe(2);
  });

  it("one_tap_unavailable: the sheet opens for the run", async () => {
    oneTapOn({ error: { code: "one_tap_unavailable" } });
    panel();
    fireEvent.click(await oneTapButton());
    expect(await screen.findByTestId("pay-sheet")).toBeTruthy();
  });

  it("amount_changed: shows the new amount and charges nothing until a fresh tap", async () => {
    oneTapOn({ serverAmountCents: 4210 });
    const taps = count("/pay-one-tap");
    panel();
    fireEvent.click(await oneTapButton());
    expect((await screen.findByTestId("one-tap-notice")).textContent).toBe(
      "The amount is now US$42.10. Check it and tap again.",
    );
    const button = screen.getByTestId("one-tap-pay") as HTMLButtonElement;
    expect(button.textContent).toBe("Pay US$42.10 with Visa •••• 4242");
    // nothing charged, no second tap on its own
    await new Promise((r) => setTimeout(r, 100));
    expect(lastRun().state).toBe("created");
    expect(taps.n).toBe(1);
    fireEvent.click(button);
    await waitFor(() => expect(lastRun().state).toBe("paid"));
    expect(lastRun().billing).toEqual({ status: "charged", charged_cents: 4210 });
    expect(taps.n).toBe(2);
  });

  it("payment_in_progress: the button is disabled and says so", async () => {
    oneTapOn({ error: { code: "payment_in_progress" } });
    panel();
    fireEvent.click(await oneTapButton());
    expect((await screen.findByTestId("one-tap-notice")).textContent).toBe(
      "A payment for this is already being confirmed.",
    );
    expect((screen.getByTestId("one-tap-pay") as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(["already_paid", "expired", "not_payable"] as const)("%s: the one-tap ends and the run is read again", async (code) => {
    oneTapOn({ error: { code } });
    const reads: string[] = [];
    server.events.on("request:start", ({ request }) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && /\/v1\/conversions\/[^/]+$/.test(path)) reads.push(path);
    });
    panel();
    fireEvent.click(await oneTapButton());
    await waitFor(() => expect(reads.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByTestId("one-tap-notice")).toBeNull());
  });

  it("Pay another way before tapping: the run opens in the sheet", async () => {
    oneTapOn();
    const taps = count("/pay-one-tap");
    panel();
    await oneTapButton();
    fireEvent.click(screen.getByTestId("one-tap-another-way"));
    expect(await screen.findByTestId("pay-sheet")).toBeTruthy();
    expect(taps.n).toBe(0);
  });
});

describe("one-tap on what the account owes (settle sheet)", () => {
  function owe(cents = 375): void {
    mockDb.billing.unpaid.push({ conversion_id: "cowed0000001", amount_cents: cents, currency: "usd", needs_action: false });
  }
  function sheet(onClose = vi.fn()): ReturnType<typeof vi.fn> {
    render(
      <AuthProvider>
        <BillingProvider>
          <SettleSheet onClose={onClose} />
        </BillingProvider>
      </AuthProvider>,
    );
    return onClose;
  }

  it("one_tap null: the form as before", async () => {
    owe();
    sheet();
    expect(await screen.findByTestId("settle-main")).toBeTruthy();
    expect(screen.queryByTestId("one-tap-pay")).toBeNull();
  });

  it("succeeded: one tap pays it, sent with the amount and the settle", async () => {
    owe();
    oneTapOn();
    const bodies: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (new URL(request.url).pathname.endsWith("/settle/one-tap")) bodies.push(await request.clone().json());
    });
    sheet();
    const button = await oneTapButton();
    expect(button.textContent).toBe("Pay US$3.75 with Visa •••• 4242");
    // no form, no local-price line
    expect(screen.queryByTestId("settle-main")).toBeNull();
    expect(document.body.textContent).not.toContain("local price");
    fireEvent.click(button);
    expect(await screen.findByText("Paid. Your downloads are back.")).toBeTruthy();
    expect(bodies).toEqual([{ amount_cents: 375, settle_id: "st_mock" }]);
    expect(mockDb.billing.unpaid).toEqual([]);
  });

  it("no double submit", async () => {
    owe();
    oneTapOn();
    const taps = count("/settle/one-tap");
    sheet();
    const button = await oneTapButton();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByText("Paid. Your downloads are back.")).toBeTruthy();
    expect(taps.n).toBe(1);
  });

  it("processing: Confirming your payment…", async () => {
    owe();
    oneTapOn({ outcome: "processing" });
    sheet();
    fireEvent.click(await oneTapButton());
    expect((await screen.findByTestId("settle-confirming")).textContent).toBe("Confirming your payment…");
  });

  it("requires_action: the bank's check here, then paid", async () => {
    owe();
    oneTapOn({ outcome: "requires_action" });
    sheet();
    fireEvent.click(await oneTapButton());
    expect(await screen.findByText("Paid. Your downloads are back.")).toBeTruthy();
  });

  it("requires_action refused by the bank: says so; Pay another way shows the form", async () => {
    owe();
    oneTapOn({ outcome: "requires_action", actionOutcome: "failed" });
    sheet();
    fireEvent.click(await oneTapButton());
    expect((await screen.findByTestId("one-tap-notice")).textContent).toBe("We couldn't confirm it with your bank.");
    fireEvent.click(screen.getByTestId("one-tap-another-way"));
    expect(await screen.findByTestId("settle-main")).toBeTruthy();
  });

  it("declined: the gateway's words, Pay another way shows the form", async () => {
    owe();
    oneTapOn({ outcome: "declined" });
    sheet();
    fireEvent.click(await oneTapButton());
    expect((await screen.findByTestId("one-tap-notice")).textContent).toBe("Your card has insufficient funds.");
    fireEvent.click(screen.getByTestId("one-tap-another-way"));
    expect(await screen.findByTestId("settle-main")).toBeTruthy();
  });

  it("one_tap_unavailable: the form", async () => {
    owe();
    oneTapOn({ error: { code: "one_tap_unavailable" } });
    sheet();
    fireEvent.click(await oneTapButton());
    expect(await screen.findByTestId("settle-main")).toBeTruthy();
  });

  it("amount_changed: the new amount, nothing charged until a fresh tap", async () => {
    owe(375);
    oneTapOn({ serverAmountCents: 500 });
    const taps = count("/settle/one-tap");
    sheet();
    fireEvent.click(await oneTapButton());
    expect((await screen.findByTestId("one-tap-notice")).textContent).toBe(
      "The amount is now US$5.00. Check it and tap again.",
    );
    expect(screen.getByTestId("one-tap-pay").textContent).toBe("Pay US$5.00 with Visa •••• 4242");
    await new Promise((r) => setTimeout(r, 100));
    expect(mockDb.billing.unpaid.length).toBe(1);
    expect(taps.n).toBe(1);
    fireEvent.click(screen.getByTestId("one-tap-pay"));
    expect(await screen.findByText("Paid. Your downloads are back.")).toBeTruthy();
    expect(taps.n).toBe(2);
  });

  it("payment_in_progress: disabled, says so", async () => {
    owe();
    oneTapOn({ error: { code: "payment_in_progress" } });
    sheet();
    fireEvent.click(await oneTapButton());
    expect((await screen.findByTestId("one-tap-notice")).textContent).toBe(
      "A payment for this is already being confirmed.",
    );
    expect((screen.getByTestId("one-tap-pay") as HTMLButtonElement).disabled).toBe(true);
  });

  it("already_paid: reads as paid", async () => {
    owe();
    oneTapOn({ error: { code: "already_paid" } });
    sheet();
    fireEvent.click(await oneTapButton());
    expect(await screen.findByText("Already paid. Your downloads are back.")).toBeTruthy();
  });

  it.each(["expired", "not_payable"] as const)("%s: the settle is opened again", async (code) => {
    owe();
    oneTapOn({ error: { code } });
    const opens = count("/v1/billing/settle");
    sheet();
    fireEvent.click(await oneTapButton());
    await waitFor(() => expect(opens.n).toBe(2));
    expect(await oneTapButton()).toBeTruthy();
  });
});

describe("the mock's routes answer like the gateway", () => {
  it("pay-one-tap 404s an unknown run", async () => {
    const res = await fetch(`${GATEWAY}/v1/conversions/cnope/pay-one-tap`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});
