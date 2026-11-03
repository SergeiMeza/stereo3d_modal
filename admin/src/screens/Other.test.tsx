import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { disputes } from "../test/fixtures";
import { apiError, FakeAuth, renderApp } from "../test/harness";

describe("disputes and fraud (A4)", () => {
  it("shows the rate against the reference line, open disputes and breakdowns", async () => {
    const { container } = renderApp("/disputes", { "GET /v1/admin/disputes/summary": () => ({ json: disputes }) });
    expect(await screen.findByText("disputes, 12 months")).toBeInTheDocument();
    expect(screen.getByText("0.45%")).toBeInTheDocument(); // 5 / 1100
    expect(screen.getByTestId("refline")).toBeInTheDocument();
    expect(screen.getByText("0.75% excessive")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Over the 0.75% line in Nov");
    expect(container.querySelectorAll(".chart .bar.over")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "CASE-0051" })).toHaveAttribute("href", "/cases/CASE-0051");
    expect(screen.getByRole("link", { name: /Whole Stripe account/ })).toHaveAttribute("href", "https://dashboard.stripe.com/test/disputes");
    expect(screen.getByText("visa")).toBeInTheDocument();
  });

  it("downloads the CSV with the token", async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return "blob:x";
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { calls } = renderApp("/disputes", {
      "GET /v1/admin/disputes/summary": ({ path }) => (path.includes("format=csv") ? { text: "month\n2026-11\n" } : { json: disputes }),
    });
    await screen.findByText("disputes, 12 months");
    await userEvent.click(screen.getByRole("button", { name: "CSV" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls.at(-1)!.headers.Authorization).toMatch(/^Bearer /);
    expect(await created[0].text()).toContain("2026-11");
  });
});

describe("account page (A3)", () => {
  const account = {
    account: { uid: "uid_123", email: "jane@example.com", stripe_customer_id: "cus_1", blocked: false },
    billing_state: { flow_state: "outstanding", sheet_only: true, sheet_only_reason: "dispute", under_review: true, lifetime_paid_cents: 9000 },
    owed_cents: 125,
    balance: null,
    methods: [{ id: "pm_1", label: "Visa •••• 4242", type: "card" }],
    cases: null,
    charges: null,
    refunds: null,
    ledger: null,
  };

  it("shows 'No account with that ID.'", async () => {
    renderApp("/accounts/nobody", { "GET /v1/admin/accounts/nobody": () => apiError(404, "no_account", "No account with that ID.") });
    expect(await screen.findByText("No account with that ID.")).toBeInTheDocument();
  });

  it("writes off what's owed after a confirm", async () => {
    const { calls } = renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: account }),
      "POST /v1/admin/accounts/uid_123/actions": () => ({ json: { ...account, owed_cents: 0 } }),
    });
    expect(await screen.findByText("Owes $1.25")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Write off $1.25…" }));
    await userEvent.click(screen.getByRole("button", { name: "Write off" }));
    await waitFor(() => expect(screen.queryByText("Owes $1.25")).toBeNull());
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ action: "write_off_owed" });
  });

  it("adjust balance needs an amount, a case and a reason", async () => {
    const { calls } = renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: account }),
      "POST /v1/admin/accounts/uid_123/actions": () => ({ json: account }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Adjust balance…" }));
    const adjust = screen.getByRole("button", { name: "Adjust" });
    expect(adjust).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Amount (negative removes)"), "-5");
    await userEvent.type(screen.getByLabelText("Case"), "CASE-0042");
    await userEvent.type(screen.getByLabelText("Reason"), "goodwill");
    await userEvent.click(adjust);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ action: "adjust_balance", cents: -500, case_id: "CASE-0042", note: "goodwill" }),
    );
  });
});

describe("sign-in and session states (A0)", () => {
  it("session expired", () => {
    renderApp("/cases", {}, new FakeAuth({ kind: "signed_out", notice: "expired" }));
    expect(screen.getByText("Your session ended. Sign in again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
  });

  it("no access", async () => {
    const auth = new FakeAuth({ kind: "no_access", email: "someone@example.com" });
    renderApp("/cases", {}, auth);
    expect(screen.getByText("This account has no access.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(auth.signOut).toHaveBeenCalled();
  });

  it("enrolment prompt shows the QR code and key, then turns the factor on", async () => {
    const auth = new FakeAuth({ kind: "enrol", email: "owner@example.com", hasFactor: false });
    renderApp("/cases", {}, auth);
    await userEvent.click(screen.getByRole("button", { name: "Set up an authenticator app" }));
    expect(await screen.findByAltText("QR code for your authenticator app")).toBeInTheDocument();
    expect(screen.getByText("ABCDEF")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Code"), "654321");
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(auth.finishEnrolment).toHaveBeenCalledWith("654321");
  });

  it("code step after Google", async () => {
    const auth = new FakeAuth({ kind: "code", label: "Authenticator app" });
    renderApp("/cases", {}, auth);
    await userEvent.type(screen.getByLabelText("Code"), "111222");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(auth.submitCode).toHaveBeenCalledWith("111222");
  });

  it("a gateway mfa_required moves the session to enrolment", async () => {
    const auth = new FakeAuth();
    renderApp("/cases", { "GET /v1/admin/cases": () => apiError(403, "mfa_required", "sign in with your second factor") }, auth);
    await waitFor(() => expect(auth.reportProblem).toHaveBeenCalledWith("mfa_required"));
  });

  it("an expired token that can't refresh ends the session", async () => {
    const auth = new FakeAuth();
    renderApp("/cases", { "GET /v1/admin/cases": () => apiError(401, "invalid_token", "expired") }, auth);
    await waitFor(() => expect(auth.reportProblem).toHaveBeenCalledWith("invalid_token"));
  });

  it("ready: the nav shows the open count", async () => {
    renderApp("/cases", {
      "GET /v1/admin/cases": () => ({ json: { cases: [], counts: { open: 3, overdue: 0, due_today: 0 } } }),
    });
    const nav = screen.getByRole("navigation", { name: "Sections" });
    await waitFor(() => expect(nav).toHaveTextContent("Cases3"));
  });
});

describe("policy and mail previews", () => {
  it("policy is read-only and names where to edit it", async () => {
    renderApp("/policy", {
      "GET /v1/admin/policy": () => ({
        json: {
          policy: { reasons: { efw: "manual", run_failed_undelivered: "auto" }, manual_above_cents: 5000, cap_exempt: ["run_failed_undelivered"], deadline_business_days: 2, reminder_hours: 48, timezone: "Asia/Tokyo", dispute_alert_pct: 0.0075, notify: { slack_channel: "", owner_emails: null } },
          edit_in: "config/refund_policy_test",
        },
      }),
    });
    expect(await screen.findByText("config/refund_policy_test")).toBeInTheDocument();
    expect(screen.getByText("exempt")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("mail previews render as plain text", async () => {
    renderApp("/mails", {
      "GET /v1/admin/mail-previews": () => ({ json: { mails: [{ id: "E9", subject: "S", text: "<b>hi</b>" }], deny_templates: null } }),
    });
    expect(await screen.findByText("<b>hi</b>")).toBeInTheDocument();
  });
});
