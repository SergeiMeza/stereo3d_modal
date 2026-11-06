/**
 * The account's emails (gateway 00152): the list with Main / Make main /
 * Remove, "Add another email" with a code and "Make it my main email",
 * the refusals in plain words, Confirm it's you on writes, and the plan's
 * "Add an email for your plan".
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ReauthSheet } from "@/components/auth/ReauthSheet";
import { PlanCard } from "@/components/billing/PlanCard";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { AccountEmails } from "./AccountEmails";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/account",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

function renderEmails(): void {
  render(
    <AuthProvider>
      <BillingProvider>
        <AccountEmails />
        <ReauthSheet />
      </BillingProvider>
    </AuthProvider>,
  );
}

async function addEmail(form: HTMLElement, email: string, code = "123456"): Promise<void> {
  fireEvent.change(within(form).getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(within(form).getByRole("button", { name: "Send code" }));
  fireEvent.change(await within(form).findByLabelText("Sign-in code"), { target: { value: code } });
}

function twoEmails(): void {
  mockDb.accountEmails.emails.push({ id: "em_work", email: "ken@studio.example", main: false, relay: false });
}

describe("Account → emails", () => {
  it("lists them: Main on one, Make main on the others", async () => {
    twoEmails();
    renderEmails();
    const main = await screen.findByTestId("email-dev@example.com");
    expect(within(main).getByText("Main")).toBeTruthy();
    const other = screen.getByTestId("email-ken@studio.example");
    fireEvent.click(within(other).getByRole("button", { name: "Make main" }));
    await waitFor(() => expect(within(screen.getByTestId("email-ken@studio.example")).getByText("Main")).toBeTruthy());
    expect(mockDb.accountEmails.emails.find((e) => e.main)?.email).toBe("ken@studio.example");
  });

  it("Add another email: a code, then it's on the list, main when asked", async () => {
    renderEmails();
    fireEvent.click(await screen.findByRole("button", { name: "Add another email" }));
    const form = await screen.findByTestId("add-email-form");
    fireEvent.click(within(form).getByRole("switch"));
    await addEmail(form, "new@studio.example");
    const row = await screen.findByTestId("email-new@studio.example");
    expect(within(row).getByText("Main")).toBeTruthy();
  });

  it("another account's email: says how it signs in, and offers to sign in to it", async () => {
    mockDb.emailsTakenBy.set("taken@studio.example", ["google.com", "email"]);
    renderEmails();
    fireEvent.click(await screen.findByRole("button", { name: "Add another email" }));
    const form = await screen.findByTestId("add-email-form");
    await addEmail(form, "taken@studio.example");
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toContain("That email belongs to another account (it signs in with Google or an email code).");
    expect(within(alert).getByRole("button", { name: "Sign in to that account" })).toBeTruthy();
  });

  it.each([
    ["main_email_not_removable", "dev@example.com", "Make another email main first."],
  ])("Remove refused (%s) in plain words", async (_code, email, words) => {
    twoEmails();
    renderEmails();
    fireEvent.click(await screen.findByRole("button", { name: `Remove ${email}` }));
    expect((await screen.findByRole("alert")).textContent).toBe(words);
  });

  it("last_method shows the gateway's words", async () => {
    twoEmails();
    server.use(
      http.delete(/\/v1\/account\/emails\/em_work$/, () =>
        HttpResponse.json({ success: false, error: "last_method", message: "That's your only way to sign in. Add another first." }, { status: 409 }),
      ),
    );
    renderEmails();
    fireEvent.click(await screen.findByRole("button", { name: "Remove ken@studio.example" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That's your only way to sign in. Add another first.");
  });

  it("five emails: no Add another email", async () => {
    for (let i = 2; i <= 5; i++) mockDb.accountEmails.emails.push({ id: `em_${i}`, email: `e${i}@x.example`, main: false, relay: false });
    renderEmails();
    expect(await screen.findByText("Your account has 5 emails. Remove one to add another.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add another email" })).toBeNull();
  });

  it("an old sign-in asks Confirm it's you, then removes", async () => {
    twoEmails();
    let n = 0;
    server.use(
      http.delete(`${GATEWAY}/v1/account/emails/em_work`, () => {
        n += 1;
        return n === 1
          ? HttpResponse.json({ success: false, error: "reauth_required", message: "sign in again", details: { max_age_s: 300, method: "firebase" } }, { status: 401 })
          : undefined;
      }),
    );
    renderEmails();
    fireEvent.click(await screen.findByRole("button", { name: "Remove ken@studio.example" }));
    const sheet = await screen.findByTestId("reauth-sheet");
    fireEvent.click(within(sheet).getByRole("button", { name: "Send a code to dev@example.com" }));
    fireEvent.change(await within(sheet).findByLabelText("Sign-in code"), { target: { value: "123456" } });
    await waitFor(() => expect(screen.queryByTestId("email-ken@studio.example")).toBeNull());
    expect(n).toBe(2);
  });
});

describe("Add an email for your plan", () => {
  function studioOnRelay(): void {
    mockDb.billing.plan = {
      plan: "studio", name: "Studio", status: "active", active: true, monthly_cents: 99900, credit_cents: 150000,
      credit_left_cents: 150000, cancel_at_period_end: false, current_period_end: "2027-01-10T12:00:00Z", interval: "year", price_cents: 1198800,
    };
    mockDb.accountEmails = {
      emails: [{ id: "em_relay", email: "x1y2@privaterelay.appleid.com", main: true, relay: true }],
      plan_email_needed: true,
    };
  }

  it("shows on the plan card until a real email is main", async () => {
    studioOnRelay();
    render(
      <AuthProvider>
        <BillingProvider>
          <PlanCard />
        </BillingProvider>
      </AuthProvider>,
    );
    const prompt = await screen.findByTestId("plan-email-prompt");
    expect(within(prompt).getByText("Add an email for your plan")).toBeTruthy();
    await addEmail(prompt, "ken@studio.example");
    await waitFor(() => expect(screen.queryByTestId("plan-email-prompt")).toBeNull());
    expect(mockDb.accountEmails.emails.find((e) => e.main)?.email).toBe("ken@studio.example");
    // the plan card stays
    expect(screen.getByTestId("plan-card")).toBeTruthy();
  });

  it("refuses a hidden Apple address before sending a code", async () => {
    studioOnRelay();
    renderEmails();
    const prompt = await screen.findByTestId("plan-email-prompt");
    fireEvent.change(within(prompt).getByLabelText("Email"), { target: { value: "abc@privaterelay.appleid.com" } });
    fireEvent.click(within(prompt).getByRole("button", { name: "Send code" }));
    expect((await within(prompt).findByRole("alert")).textContent).toBe(
      "Use a real email for your plan, not a hidden Apple address.",
    );
  });
});
