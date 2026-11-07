/**
 * Duo pass (owner 2026-11-07, foldable): every payment surface fits the
 * height you can see. The sheet is capped at svh/dvh less the safe areas,
 * its body and footer scroll together with the footer pinned, and on
 * cramped heights only the main button stays pinned (footers marked
 * data-pin-main dissolve). The pay link page is a page: Pay ends the flow.
 */
import fs from "node:fs";
import path from "node:path";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SheetFrame } from "@/components/ui/sheet-frame";
import { resetPricingCache } from "@/lib/api/usePricing";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { AddFundsSheet } from "./BalanceDialogs";
import { MainButtonArea } from "./PaySheet";
import { PayRequestPage } from "./PayRequestPage";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/account/billing",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => resetPricingCache());
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const css = fs.readFileSync(path.join(__dirname, "../../app/globals.css"), "utf8");

describe("payment sheets on short screens", () => {
  it("the frame is capped at the visible height, never a fixed 90vh alone", () => {
    expect(css).toMatch(/@custom-variant cramped \(@media \(max-height: 560px\)\)/);
    for (const cls of ["sheet-frame-phone", "sheet-frame-centred"]) {
      const rule = css.slice(css.indexOf(`.${cls} {`), css.indexOf("}", css.indexOf(`.${cls} {`)));
      expect(rule).toContain("100svh");
      expect(rule).toContain("100dvh - env(safe-area-inset-top");
    }
    render(
      <SheetFrame open onClose={() => {}} title="Pay" testId="frame" footer={<button type="button">Pay</button>}>
        <p>form</p>
      </SheetFrame>,
    );
    const frame = screen.getByTestId("frame");
    expect(frame.className).toMatch(/\bsheet-frame-(centred|phone)\b/);
    expect(frame.className).not.toContain("max-h-[90vh]");
    expect(frame.className).not.toMatch(/\btop-0\b/);
  });

  it("the body and the footer share one scroll; the footer is pinned, and dissolves on cramped heights only when marked", () => {
    render(
      <SheetFrame
        open
        onClose={() => {}}
        title="Pay"
        testId="frame"
        footer={<MainButtonArea lines={["line"]} button={<button type="button">Pay $3.75</button>} foot="small print" />}
      >
        <p>form</p>
      </SheetFrame>,
    );
    const scroll = screen.getByTestId("sheet-scroll");
    const footer = screen.getByTestId("sheet-footer");
    expect(scroll.className).toMatch(/\boverflow-y-auto\b/);
    expect(scroll.contains(screen.getByText("form"))).toBe(true);
    expect(scroll.contains(footer)).toBe(true);
    expect(footer.className).toMatch(/\bsticky bottom-0\b/);
    expect(footer.className).toContain("cramped:has-[[data-pin-main]]:contents");
    expect(footer.className).not.toMatch(/(^|\s)cramped:contents(\s|$)/);
    // MainButtonArea: marked, and its button pinned on its own
    const root = footer.firstElementChild as HTMLElement;
    expect(root.hasAttribute("data-pin-main")).toBe(true);
    expect(root.className).toContain("cramped:contents");
    const area = screen.getByTestId("pay-main-area");
    expect(within(area).getByText("Pay $3.75")).toBeTruthy();
    expect(area.className).toContain("cramped:sticky");
    expect(area.className).toContain("cramped:bottom-0");
  });

  it("the top-up sheet pins its Add button the same way", async () => {
    render(
      <AuthProvider>
        <BillingProvider>
          <AddFundsSheet onClose={vi.fn()} />
        </BillingProvider>
      </AuthProvider>,
    );
    const main = await screen.findByTestId("add-funds-main");
    const area = main.closest('[data-testid="pay-main-area"]') as HTMLElement;
    expect(area).toBeTruthy();
    expect(area.className).toContain("cramped:sticky");
    expect(area.closest("[data-pin-main]")).toBeTruthy();
    // short screens: a slim balance line and smaller chips leave room for the form
    expect(screen.getByTestId("funds-balance-row").className).toContain("cramped:py-0");
    for (const chip of screen.getAllByRole("radio")) expect(chip.className).toContain("cramped:h-9");
  });
});

describe("the pay link page on short screens", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("keeps Pay as the last item in the flow, never pinned over the form (real Safari)", async () => {
    mockDb.payRequests.set("tok_fold", {
      amount_cents: 2500,
      currency: "usd",
      label: "Top-up",
      state: "open",
      flow: "checkout",
    });
    render(
      <AuthProvider>
        <PayRequestPage token="tok_fold" />
      </AuthProvider>,
    );
    fireEvent.click(await screen.findByTestId("pay-request-pay"));
    const confirm = await screen.findByTestId("pay-request-confirm");
    const footer = confirm.closest('[data-testid="pay-request-footer"]') as HTMLElement;
    expect(footer).toBeTruthy();
    expect(footer.className).not.toMatch(/\b(sticky|fixed)\b/);
    expect(footer.className).toContain("env(safe-area-inset-bottom)");
    // nothing of the form comes after it
    expect(footer.nextElementSibling).toBeNull();
  });
});
