import { screen, waitFor, within } from "@testing-library/react";
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

  it("shows the business details on the account's invoices", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({
        json: {
          ...account,
          company: {
            company_name: "Northlight Films",
            address: { line1: "1 King St", city: "London", postal_code: "EC2V 8AU", country: "GB" },
            tax_id: { type: "gb_vat", value: "GB123456789", verification: "verified" },
            billing_email: "accounts@northlight.example",
            po_reference: "PO-2211",
          },
        },
      }),
    });
    const card = await screen.findByTestId("account-company");
    expect(card).toHaveTextContent("Northlight Films");
    expect(card).toHaveTextContent("1 King St, EC2V 8AU London, GB");
    expect(card).toHaveTextContent("gb_vat GB123456789 · verified");
    expect(card).toHaveTextContent("PO-2211");
  });

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

describe("grants (00106)", () => {
  const account = {
    account: { uid: "uid_123", email: "jane@example.com", stripe_customer_id: "cus_1", blocked: false },
    billing_state: { flow_state: "ok", sheet_only: false, lifetime_paid_cents: 0 },
    owed_cents: 0,
    balance: null,
    methods: null,
    cases: null,
    charges: null,
    refunds: null,
    ledger: null,
  };
  const grant = (over: Record<string, unknown> = {}) => ({
    id: "gr_1",
    uid: "uid_123",
    entitlement: "pro",
    ends_at: "2026-12-04T10:00:00Z",
    granted_by: "owner@example.com",
    reason: "creator partnership",
    created_at: "2026-11-04T10:00:00Z",
    status: "active",
    ...over,
  });

  it("lists grants with status chips; Revoke only on active ones", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({
        json: {
          ...account,
          grants: [
            grant(),
            grant({ id: "gr_2", status: "failed", rc_error: "subscriber not found", created_at: "2026-11-03T10:00:00Z" }),
            grant({ id: "gr_3", status: "revoked", revoked_by: "owner@example.com", revoke_reason: "ended early", created_at: "2026-11-02T10:00:00Z" }),
          ],
          promo_regrants: [{ id: "pr_1", status: "regranted", entitlement: "pro", ends_at: "2027-01-01T00:00:00Z" }],
        },
      }),
    });
    const active = await screen.findByTestId("grant-gr_1");
    expect(active).toHaveTextContent("Active");
    expect(within(active).getByRole("button", { name: "Revoke…" })).toBeInTheDocument();
    const failed = screen.getByTestId("grant-gr_2");
    expect(failed).toHaveTextContent("Failed");
    expect(failed).toHaveTextContent("subscriber not found");
    expect(within(failed).queryByRole("button", { name: "Revoke…" })).toBeNull();
    expect(screen.getByTestId("grant-gr_3")).toHaveTextContent("ended early");
    expect(screen.getByTestId("promo-regrants")).toHaveTextContent("Regranted");
  });

  it("grants Pro for a preset with a reason, signing in again when asked", async () => {
    let posts = 0;
    const auth = new FakeAuth();
    const { calls } = renderApp(
      "/accounts/uid_123",
      {
        "GET /v1/admin/accounts/uid_123": () => ({ json: { ...account, grants: [] } }),
        "POST /v1/admin/accounts/uid_123/grants": ({ body }) => {
          posts++;
          if (posts === 1) return apiError(401, "reauth_required", "again");
          const b = body as { entitlement: string; ends_at: string; reason: string };
          return { status: 201, json: { grant: grant({ id: "gr_9", entitlement: b.entitlement, ends_at: b.ends_at, reason: b.reason }) } };
        },
      },
      auth,
    );
    expect(await screen.findByText("No grants.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Grant Pro…" }));
    const sheet = screen.getByRole("dialog", { name: "Grant Pro" });
    const submit = within(sheet).getByRole("button", { name: "Grant Pro" });
    expect(submit).toBeDisabled(); // reason required
    await userEvent.selectOptions(within(sheet).getByLabelText("Entitlement"), "business");
    await userEvent.click(within(sheet).getByLabelText("1 week"));
    await userEvent.type(within(sheet).getByLabelText(/Reason/), "conference speaker");
    await userEvent.click(within(sheet).getByRole("button", { name: "Grant Business" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await userEvent.click(within(reauth).getByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(posts).toBe(2));
    expect(auth.reauthenticate).toHaveBeenCalledTimes(1);
    const body = calls.filter((c) => c.method === "POST").at(-1)!.body as { entitlement: string; ends_at: string; reason: string };
    expect(body.entitlement).toBe("business");
    expect(body.reason).toBe("conference speaker");
    const days = (Date.parse(body.ends_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(await screen.findByTestId("grant-gr_9")).toHaveTextContent("Business");
    expect(screen.getByRole("status")).toHaveTextContent("Business granted until");
  });

  it("a custom end date outside 1 hour to 5 years can't be sent", async () => {
    renderApp("/accounts/uid_123", { "GET /v1/admin/accounts/uid_123": () => ({ json: account }) });
    await userEvent.click(await screen.findByRole("button", { name: "Grant Pro…" }));
    const sheet = screen.getByRole("dialog", { name: "Grant Pro" });
    await userEvent.click(within(sheet).getByLabelText("Custom"));
    await userEvent.type(within(sheet).getByLabelText(/Reason/), "test");
    const date = within(sheet).getByLabelText(/End date/);
    await userEvent.type(date, "2040-01-01");
    expect(within(sheet).getByText("Pick a date from 1 hour to 5 years ahead.")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Grant Pro" })).toBeDisabled();
  });

  it("502 grant_failed shows the message and keeps the failed record", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: account }),
      "POST /v1/admin/accounts/uid_123/grants": () => ({
        status: 502,
        json: {
          success: false,
          error: "grant_failed",
          message: "RevenueCat said no",
          grant: grant({ id: "gr_f", status: "failed", rc_error: "RevenueCat said no" }),
        },
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Grant Pro…" }));
    const sheet = screen.getByRole("dialog", { name: "Grant Pro" });
    await userEvent.type(within(sheet).getByLabelText(/Reason/), "support");
    await userEvent.click(within(sheet).getByRole("button", { name: "Grant Pro" }));
    expect(await screen.findByTestId("grant-gr_f")).toHaveTextContent("Failed");
    expect(screen.getByRole("status")).toHaveTextContent("Not granted: RevenueCat said no");
  });

  it("503 rc_unavailable keeps the sheet open with a retry hint", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: account }),
      "POST /v1/admin/accounts/uid_123/grants": () => apiError(503, "rc_unavailable", "down"),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Grant Pro…" }));
    const sheet = screen.getByRole("dialog", { name: "Grant Pro" });
    await userEvent.type(within(sheet).getByLabelText(/Reason/), "support");
    await userEvent.click(within(sheet).getByRole("button", { name: "Grant Pro" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Nothing was granted");
  });

  it("revokes with a reason; a 202 says some grants will be retried tonight", async () => {
    const { calls } = renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: { ...account, grants: [grant()] } }),
      "DELETE /v1/admin/accounts/uid_123/grants/gr_1": () => ({
        status: 202,
        json: {
          grant: grant({ status: "revoked", revoked_by: "owner@example.com", revoke_reason: "partnership ended" }),
          regrant: { id: "rg_1", status: "partial", regranted: 0, skipped: 1 },
        },
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Revoke…" }));
    const sheet = screen.getByRole("dialog", { name: "Revoke Pro" });
    const revoke = within(sheet).getByRole("button", { name: "Revoke" });
    expect(revoke).toBeDisabled();
    await userEvent.type(within(sheet).getByLabelText(/Reason/), "partnership ended");
    await userEvent.click(revoke);
    expect(await screen.findByRole("status")).toHaveTextContent("Some grants will be retried tonight");
    expect(screen.getByTestId("grant-gr_1")).toHaveTextContent("Revoked");
    expect(calls.find((c) => c.method === "DELETE")!.body).toEqual({ reason: "partnership ended" });
  });

  it("409 grant_not_active says so", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: { ...account, grants: [grant()] } }),
      "DELETE /v1/admin/accounts/uid_123/grants/gr_1": () => apiError(409, "grant_not_active", "not active"),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Revoke…" }));
    const sheet = screen.getByRole("dialog", { name: "Revoke Pro" });
    await userEvent.type(within(sheet).getByLabelText(/Reason/), "x");
    await userEvent.click(within(sheet).getByRole("button", { name: "Revoke" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("This grant isn't active any more.");
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

describe("onboarding answers (owner 2026-11-04)", () => {
  it("shows people and conversion per device, by week and by plan", async () => {
    const { calls } = renderApp("/onboarding", {
      "GET /v1/admin/onboarding/headsets": () => ({
        json: {
          days: 90,
          by_day: [
            { day: "2026-11-02", device: "avp", count: 3 },
            { day: "2026-11-03", device: "quest", count: 5 },
          ],
          by_plan: [
            { plan: "none", device: "quest", count: 4 },
            { plan: "pro", device: "avp", count: 3 },
          ],
          conversion: [
            { device: "avp", people: 3, converted: 1 },
            { device: "quest", people: 5, converted: 1 },
          ],
          business_setup: [
            { step: "opened", people: 20 },
            { step: "plan_picked", people: 10, by_plan: { business: 8, studio: 2 } },
            { step: "purchased", people: 2, by_plan: { business: 2 } },
          ],
          by_variant: [
            { variant: "default", device: "quest", count: 5, converted: 1 },
            { variant: "app_pro", device: "avp", count: 3, converted: 1 },
          ],
          generated_at: "2026-11-04T00:00:00Z",
        },
      }),
    });
    const table = await screen.findByTestId("onboarding-conversion");
    expect(table).toHaveTextContent("Meta Quest51");
    expect(table).toHaveTextContent("Apple Vision Pro31");
    expect(screen.getByText("device answers")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-plans")).toHaveTextContent("Pro");
    const variants = screen.getByTestId("onboarding-variants");
    expect(variants).toHaveTextContent("App Pro welcome");
    expect(variants).toHaveTextContent("Web welcome");
    expect(variants).toHaveTextContent("Converted1 · 33%1 · 20%");
    const funnel = screen.getByTestId("onboarding-setup-funnel");
    expect(funnel).toHaveTextContent("Picked a plan1050%82");
    expect(funnel).toHaveTextContent("Bought210%2—");
    expect(calls.at(-1)!.url).toContain("days=90");
  });
});

describe("plans surfaces (owner 2026-11-04)", () => {
  it("lists each placement with clicks and attributed plan starts", async () => {
    const { calls } = renderApp("/plans", {
      "GET /v1/admin/plans/surfaces": () => ({
        json: {
          days: 30,
          generated_at: "2026-11-04T00:00:00Z",
          placements: [
            { placement: "quote", views: 200, viewers: 120, dismissals: 10, clicks: 30, conversions: 6, conversions_by_product: { pro: 5, business: 1 }, click_rate: 0.15, conversion_rate: 0.03 },
            { placement: "header", views: 900, viewers: 300, dismissals: 0, clicks: 40, conversions: 2, conversions_by_product: { pro: 2 }, click_rate: 0.044, conversion_rate: 0.002 },
          ],
          unattributed: { conversions: 3, by_product: { pro: 3 } },
          by_reason: [
            { placement: "business_note", reason: "source_8k", views: 40, viewers: 30, dismissals: 4, clicks: 8, conversions: 1, conversions_by_product: { business: 1 }, click_rate: 0.2, conversion_rate: 0.025 },
          ],
        },
      }),
    });
    const table = await screen.findByTestId("plans-surfaces");
    expect(table).toHaveTextContent("Quote · pay once or with Pro");
    expect(table).toHaveTextContent("Pro 5 · Business 1");
    expect(screen.getByTestId("plans-surfaces-reasons")).toHaveTextContent("Source above 4K");
    expect(screen.getByText(/Plan starts with no click in the 7 days before: 3/)).toBeInTheDocument();
    expect(calls.at(-1)!.url).toContain("days=30");
  });
});

describe("feedback (owner 2026-11-04)", () => {
  it("lists web and app feedback, read only, by platform", async () => {
    const { calls } = renderApp("/feedback", {
      "GET /v1/admin/feedback": () => ({
        json: {
          days: 30,
          items: [
            { id: "f1", created_at: "2026-11-04T01:00:00Z", platform: "web", kind: "problem", message: "Preview stalls", email: "a@b.com", ok_to_contact: true, context: { route: "/projects/p1", project_id: "p1" } },
            { id: "f2", created_at: "2026-11-03T01:00:00Z", platform: "ios", kind: "idea", message: "Batch export", app_version: "10.5.3" },
          ],
        },
      }),
    });
    const table = await screen.findByTestId("feedback-list");
    expect(table).toHaveTextContent("Preview stalls");
    expect(table).toHaveTextContent("iPhone/iPad 10.5.3");
    expect(table).toHaveTextContent("project p1");
    expect(calls.at(-1)!.url).toContain("days=30");
  });
});
