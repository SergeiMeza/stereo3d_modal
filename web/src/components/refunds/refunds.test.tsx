/**
 * Refunds on request (owner 2026-11-06): no automatic refunds unless the
 * customer asks; a person reviews every request, within 30 days of the
 * payment. Plan & billing's Refunds, the sheet, the history row entry,
 * Your requests with replies, App Store Pro, and the gateway's refusals.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import projectFixture from "../../../fixtures/project.json";
import { ReauthSheet } from "@/components/auth/ReauthSheet";
import { BillingScreen } from "@/components/billing/BillingScreen";
import type { Conversion } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { appStore } from "@/lib/state/stores";

import { openRefundSheetAtom } from "./refundAtoms";
import { REVIEW_LINE } from "./RefundSheet";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/account/billing",
  useSearchParams: () => new URLSearchParams(),
}));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const PID = (projectFixture as { project_id: string }).project_id;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  mockDb.reset();
  delete (globalThis as { __mockDb?: typeof mockDb }).__mockDb;
});
afterAll(() => server.close());

function renderBilling(): void {
  render(
    <AuthProvider>
      <BillingProvider>
        <BillingScreen />
        <ReauthSheet />
      </BillingProvider>
    </AuthProvider>,
  );
}

function planOption(over: Record<string, unknown> = {}): void {
  planRow();
  mockDb.refundOptions.plan = {
    invoice_id: "in_plan_1",
    plan: "business",
    name: "Business",
    paid_at: "2026-11-03T09:00:00Z",
    paid_cents: 29900,
    cancelled: false,
    open_request_id: null,
    ...over,
  } as never;
}

function runOption(id: string, cents: number): void {
  mockDb.refundOptions.runs.push({ conversion_id: id, label: "Holiday clip · 4K", paid_at: "2026-11-02T10:30:00Z", amount_cents: cents, open_request_id: null });
}

/** A plan invoice row in Billing history, for the plan option's invoice. */
function planRow(): void {
  (mockDb.billing as unknown as { planHistory: unknown[] }).planHistory.push({
    row_id: "plan_in_plan_1",
    kind: "plan",
    created_at: "2026-11-03T09:00:00Z",
    amount_cents: 29900,
    currency: "usd",
    status: "paid",
    label: "Business plan · monthly",
    plan: { tier: "business", interval: "monthly", reason: "first", invoice_id: "in_plan_1" },
    items: [],
  });
}

/** A row's "More" menu (Radix opens from the keyboard in jsdom). */
async function openRowMenu(row: HTMLElement): Promise<void> {
  fireEvent.keyDown(within(row).getByRole("button", { name: "More" }), { key: "Enter" });
  await screen.findByRole("menu");
}

/** The sheet with the plan picked. Its ways in are hidden for now
 * (SHOW_REFUND_ENTRY), so the tests open it through its atom, as they did. */
async function requestPlanFromRow(): Promise<HTMLElement> {
  await screen.findByTestId("row-plan_in_plan_1");
  act(() => appStore.set(openRefundSheetAtom, { plan: true }));
  const sheet = await screen.findByTestId("refund-sheet");
  await within(sheet).findByLabelText(/Business plan/);
  return sheet;
}

/** Captures what was sent to POST /v1/support/refund-requests. */
function captureRequests(): unknown[] {
  const bodies: unknown[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "POST" && request.url.endsWith("/v1/support/refund-requests")) bodies.push(await request.clone().json());
  });
  return bodies;
}

describe("Request a refund", () => {
  it("the plan's payment: pick, note, Send, review line, Cancel your plan too?, and Your requests", async () => {
    planOption();
    const bodies = captureRequests();
    renderBilling();
    const sheet = await requestPlanFromRow();
    expect((within(sheet).getByLabelText(/Business plan/) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(sheet).getByLabelText("What happened? (optional)"), { target: { value: "I didn't use it" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Send" }));
    expect(await within(sheet).findByText(REVIEW_LINE)).toBeTruthy();
    const cancel = within(sheet).getByTestId("refund-cancel-too");
    expect(cancel.textContent).toContain("Cancel your plan too?");
    expect(within(cancel).getByRole("link", { name: "Cancel plan" }).getAttribute("href")).toBe("/account/billing?cancel=1");
    expect(bodies).toEqual([{ plan: true, text: "I didn't use it" }]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    const req = await screen.findByTestId("support-requests");
    expect(within(req).getByTestId("request-status").textContent).toBe("We're looking at it");
  });

  it("each charge's menu keeps only Get help with this payment (SHOW_REFUND_ENTRY off)", async () => {
    planOption();
    renderBilling();
    await openRowMenu(await screen.findByTestId("row-plan_in_plan_1"));
    expect(await screen.findByTestId("row-help")).toBeTruthy();
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Get help with this payment"]);
    expect(screen.queryByTestId("row-refund")).toBeNull();
    expect(screen.queryByTestId("row-refund-asked")).toBeNull();
  });

  it("a cancelled plan isn't offered cancelling again", async () => {
    planOption({ cancelled: true });
    renderBilling();
    const sheet = await requestPlanFromRow();
    fireEvent.click(within(sheet).getByRole("button", { name: "Send" }));
    expect(await within(sheet).findByText(REVIEW_LINE)).toBeTruthy();
    expect(within(sheet).queryByTestId("refund-cancel-too")).toBeNull();
  });

  it("a finished run, picked when the sheet opens for it", async () => {
    const c: Conversion = {
      conversion_id: "crun00000001", state: "succeeded", kind: "video", project_id: PID, step: "production", method: "lifelike",
      params: { preset: "4k", formats: ["mvhevc"] }, quote: { amount_cents: 1250, currency: "usd" }, progress: 1, outputs: ["mvhevc"],
      billing: { status: "charged", charged_cents: 1250 }, created_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-02T10:30:00Z",
    };
    mockDb.conversions.set(c.conversion_id, c);
    runOption("crun00000001", 1250);
    const bodies = captureRequests();
    renderBilling();
    await screen.findByTestId("history");
    act(() => appStore.set(openRefundSheetAtom, { conversionIds: ["crun00000001"] }));
    const sheet = await screen.findByTestId("refund-sheet");
    expect(((await within(sheet).findByLabelText(/Holiday clip/)) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(sheet).getByRole("button", { name: "Send" }));
    expect(await within(sheet).findByText(REVIEW_LINE)).toBeTruthy();
    expect(bodies).toEqual([{ conversion_ids: ["crun00000001"] }]);
    // no plan in it: nothing about cancelling
    expect(within(sheet).queryByTestId("refund-cancel-too")).toBeNull();
  });

  it("needs a fresh sign-in: Confirm it's you, then it's sent", async () => {
    planOption();
    let n = 0;
    server.use(
      http.post(`${GATEWAY}/v1/support/refund-requests`, () => {
        n += 1;
        return n === 1
          ? HttpResponse.json({ success: false, error: "reauth_required", message: "sign in again", details: { max_age_s: 300, method: "firebase" } }, { status: 401 })
          : undefined;
      }),
    );
    renderBilling();
    const sheet = await requestPlanFromRow();
    fireEvent.click(within(sheet).getByRole("button", { name: "Send" }));
    const confirm = await screen.findByTestId("reauth-sheet");
    fireEvent.click(within(confirm).getByRole("button", { name: "Send a code to dev@example.com" }));
    fireEvent.change(await within(confirm).findByLabelText("Sign-in code"), { target: { value: "123456" } });
    expect(await within(sheet).findByText(REVIEW_LINE)).toBeTruthy();
    expect(n).toBe(2);
  });

  it.each([
    [409, "too_many_open", "You have 10 requests we're still looking at. We'll answer those first."],
    [403, "account_deleted", "This account was deleted."],
    [429, "rate_limited", "Too many requests. Try again later."],
  ])("%s %s shows the gateway's words", async (status, code, words) => {
    planOption();
    server.use(
      http.post(`${GATEWAY}/v1/support/refund-requests`, () =>
        HttpResponse.json({ success: false, error: code, message: words }, { status }),
      ),
    );
    renderBilling();
    const sheet = await requestPlanFromRow();
    fireEvent.click(within(sheet).getByRole("button", { name: "Send" }));
    expect((await within(sheet).findByRole("alert")).textContent).toBe(words);
  });

  it("the note keeps to 2,000 characters", async () => {
    planOption();
    renderBilling();
    const note = within(await requestPlanFromRow()).getByLabelText("What happened? (optional)");
    expect(note.getAttribute("maxlength")).toBe("2000");
  });
});

describe("quiet on Billing (owner 2026-11-07)", () => {
  it("the refund lines are hidden for now; one Report a problem line, after Purchases and invoices", async () => {
    planOption();
    mockDb.proStatus = { pro: true, known: true, source: "app_store", scheduled_change: null };
    (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
    renderBilling();
    const report = await screen.findByTestId("report-problem");
    expect(report.textContent).toBe("Something wrong with a payment or a run? Report a problem");
    const link = within(report).getByRole("link", { name: "Report a problem" });
    expect(decodeURIComponent(link.getAttribute("href")!)).toMatch(/^mailto:.+\?subject=Spatial Video Studio: report a problem$/);
    expect(report.textContent).not.toMatch(/refund/i);
    // below the purchases
    const purchases = screen.getByRole("region", { name: "Purchases and invoices" });
    expect(purchases.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // hidden: both sentences and the App Store line
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByTestId("refunds-line")).toBeNull();
    expect(screen.queryByTestId("refund-app-store")).toBeNull();
    expect(screen.queryByText(/Ask Apple for a refund/)).toBeNull();
    // no requests yet: no list
    expect(screen.queryByTestId("support-requests")).toBeNull();
  });

  it("a question waiting: one line at the top, and Answer it goes to the request", async () => {
    mockDb.supportRequests = [
      { id: "req_9", about: "runs", state: "asked", status: "We asked you a question", opened_at: "2026-11-04T09:00:00Z", question: "Which part?" },
    ];
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderBilling();
    const notice = await screen.findByTestId("refund-question-notice");
    expect(notice.textContent).toBe("We asked a question about your refund request. Answer it");
    // above the Balance, the only refund element up there
    expect(notice.compareDocumentPosition(screen.getByTestId("refunds")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await screen.findByTestId("request-req_9");
    fireEvent.click(within(notice).getByRole("link", { name: "Answer it" }));
    expect(scroll).toHaveBeenCalled();
  });

  it("no question waiting: no notice", async () => {
    mockDb.supportRequests = [{ id: "req_1", about: "plan", state: "looking", status: "We're looking at it", opened_at: "2026-11-04T09:00:00Z" }];
    renderBilling();
    await screen.findByTestId("request-req_1");
    expect(screen.queryByTestId("refund-question-notice")).toBeNull();
  });
});

describe("Your requests", () => {
  it("a question we asked can be answered, and the request goes back to review", async () => {
    mockDb.supportRequests = [
      {
        id: "req_9", about: "runs", state: "asked", status: "We asked you a question", opened_at: "2026-11-04T09:00:00Z",
        requested_cents: 1250, question: "Which part of the video looked wrong?", conversion_ids: ["c1"],
      },
    ];
    renderBilling();
    const row = await screen.findByTestId("request-req_9");
    expect(within(row).getByTestId("request-status").textContent).toBe("We asked you a question");
    expect(within(row).getByTestId("request-question").textContent).toBe("Which part of the video looked wrong?");
    fireEvent.change(within(row).getByLabelText("Your answer"), { target: { value: "The last ten seconds" } });
    fireEvent.click(within(row).getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(within(screen.getByTestId("request-req_9")).getByTestId("request-status").textContent).toBe("We're looking at it"));
  });

  it("a closed request can be asked about again (a follow-up)", async () => {
    mockDb.supportRequests = [
      { id: "req_1", about: "plan", state: "not_refunded", status: "Not refunded", opened_at: "2026-11-01T09:00:00Z" },
    ];
    renderBilling();
    const row = await screen.findByTestId("request-req_1");
    fireEvent.click(within(row).getByRole("button", { name: "Ask about this again" }));
    fireEvent.change(within(row).getByLabelText("Your message"), { target: { value: "Please look again" } });
    fireEvent.click(within(row).getByRole("button", { name: "Send" }));
    expect(await screen.findByTestId("request-req_2")).toBeTruthy();
  });
});

describe("App Store Pro", () => {
  it("the Ask Apple line is hidden with the other refund lines for now (SHOW_REFUND_FOOTER)", async () => {
    mockDb.proStatus = { pro: true, known: true, source: "app_store", scheduled_change: null };
    (globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;
    renderBilling();
    await screen.findByTestId("report-problem");
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByTestId("refund-app-store")).toBeNull();
  });
});
