import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, delay, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { appStore } from "@/lib/state/stores";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { BillingScreen } from "./BillingScreen";
import { APP_STORE_NOTE } from "./RestorePurchases";
import { EMPTY_RESTORE, RESTORE_FAILED, restoreAtom } from "./restoreAtoms";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/account/billing",
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  appStore.set(restoreAtom, EMPTY_RESTORE);
});
afterAll(() => server.close());

function renderBilling() {
  render(
    <AuthProvider>
      <BillingProvider>
        <BillingScreen />
      </BillingProvider>
    </AuthProvider>,
  );
}

const STUDIO = {
  plan: "studio" as const,
  name: "Studio",
  status: "active",
  active: true,
  monthly_cents: 99900,
  credit_cents: 150000,
  credit_left_cents: 150000,
  cancel_at_period_end: false,
  current_period_end: "2027-11-05T12:00:00Z",
  interval: "year" as const,
  price_cents: 1198800,
};

async function tapRestore(): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name: "Restore Purchases" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  return button;
}

describe("Restore Purchases (owner 2026-11-06)", () => {
  it("nothing found: the gateway's words, and where App Store purchases show", async () => {
    renderBilling();
    const row = await screen.findByTestId("restore-purchases");
    expect(row.textContent).toContain(APP_STORE_NOTE);
    await tapRestore();
    expect((await screen.findByTestId("restore-message")).textContent).toBe("We didn't find any purchases");
    expect(screen.queryByTestId("plan-card")).toBeNull();
  });

  it("a plan repaired: restored, and the plan card shows it without a reload", async () => {
    let calls = 0;
    server.use(
      http.post(`${GATEWAY}/v1/billing/restore`, () => {
        calls++;
        mockDb.billing.plan = STUDIO; // the resync wrote the plan
        return HttpResponse.json({
          restored: true,
          repaired: ["plan", "app_access"],
          plan: STUDIO,
          pro: true,
          message: "Your purchases are restored",
        });
      }),
    );
    renderBilling();
    await screen.findByTestId("restore-purchases");
    expect(screen.queryByTestId("plan-card")).toBeNull();
    await tapRestore();
    expect((await screen.findByTestId("restore-message")).textContent).toBe("Your purchases are restored");
    expect(await screen.findByTestId("plan-card")).toBeTruthy();
    expect(calls).toBe(1);
    expect(screen.getByTestId("restore-purchases").textContent).toContain(APP_STORE_NOTE);
  });

  it("one restore at a time: the button waits while it runs", async () => {
    let calls = 0;
    server.use(
      http.post(`${GATEWAY}/v1/billing/restore`, async () => {
        calls++;
        await delay(200);
        return HttpResponse.json({ restored: false, repaired: [], plan: null, message: "We didn't find any purchases" });
      }),
    );
    renderBilling();
    const button = await tapRestore();
    await waitFor(() => expect(button.textContent).toBe("Restoring…"));
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    await screen.findByTestId("restore-message");
    expect(calls).toBe(1);
    expect(button.textContent).toBe("Restore Purchases");
  });

  it("too many tries: the refusal in its own words; a server error: try again later", async () => {
    server.use(
      http.post(`${GATEWAY}/v1/billing/restore`, () =>
        HttpResponse.json(
          { success: false, error: "rate_limited", message: "Too many tries. Try again in a while.", details: { retry_after_s: 1200 } },
          { status: 429 },
        ),
      ),
    );
    renderBilling();
    await tapRestore();
    expect((await screen.findByTestId("restore-error")).textContent).toBe("Too many tries. Try again in a while.");
    expect(screen.queryByTestId("restore-message")).toBeNull();

    server.use(
      http.post(`${GATEWAY}/v1/billing/restore`, () =>
        HttpResponse.json({ success: false, error: "restore_unavailable", message: "upstream" }, { status: 502 }),
      ),
    );
    await tapRestore();
    await waitFor(() => expect(screen.getByTestId("restore-error").textContent).toBe(RESTORE_FAILED));
  });
});
