import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { disputes } from "../test/fixtures";
import { apiError, FakeAuth, findToast, renderApp } from "../test/harness";
import { installWebAuthn, requestOptions } from "../test/webauthn";

/** The passkey re-assertion routes, as the gateway answers them. */
const passkeyRoutes = {
  "POST /v1/admin/session/options": () => ({ json: { options: { publicKey: requestOptions }, expires_at: "2026-11-04T10:05:00Z" } }),
  "POST /v1/admin/session/verify": () => ({ json: { session: "sess_2", expires_at: "2099-01-01T00:00:00Z", last_assertion_at: "2026-11-04T10:00:00Z" } }),
};

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
    // B: the current month against the line
    expect(screen.getByTestId("current-rate")).toHaveTextContent("1.00%");
    expect(screen.getByRole("img", { name: "Rate as a share of the 0.75% line: 100 percent" })).toBeInTheDocument();
    expect(screen.getByTestId("open-disputes")).toHaveTextContent("product not received");
  });

  it("shows won (recovered) beside lost, from the window totals", async () => {
    renderApp("/disputes", { "GET /v1/admin/disputes/summary": () => ({ json: { ...disputes, won_cents: 41200, lost_cents: 2000 } }) });
    const won = await screen.findByText("won (recovered)");
    expect(won.parentElement).toHaveTextContent("$412.00");
    expect(screen.getByText("lost").parentElement).toHaveTextContent("$20.00");
    expect(screen.getByText(/1 won \(\$412\.00 recovered\)/)).toBeInTheDocument();
  });

  it("lists the open early fraud warnings, linking the case when there is one", async () => {
    renderApp("/disputes", {
      "GET /v1/admin/disputes/summary": () => ({ json: disputes }),
      "GET /v1/admin/efws": () => ({
        json: {
          efws: [
            { id: "issfr_1", uid: "u1", charge: "ch_1", payment_intent: "pi_1", amount_cents: 8900, created: "2026-11-04T01:00:00Z", case_id: "CASE-1039" },
            { id: "issfr_2", uid: "u2", charge: null, payment_intent: "pi_2", amount_cents: 1198800, created: "2026-11-03T01:00:00Z", case_id: null },
          ],
        },
      }),
    });
    const list = await screen.findByTestId("open-efws");
    expect(within(list).getByRole("link", { name: "CASE-1039" })).toHaveAttribute("href", "/cases/CASE-1039");
    expect(list).toHaveTextContent("Fraud-warning hold, no case");
    expect(list).toHaveTextContent("$11,988.00");
    expect(within(list).getAllByRole("link", { name: "Account" })[1]).toHaveAttribute("href", "/accounts/u2");
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
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
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
          company_changes: [
            { at: "2026-11-01T00:00:00Z", by: "checkout", fields: ["company_name", "address"] },
            { at: "2026-11-03T00:00:00Z", by: "user", fields: ["po_reference", "billing_email"] },
          ],
        },
      }),
    });
    const card = await screen.findByTestId("account-company");
    expect(card).toHaveTextContent("Northlight Films");
    expect(card).toHaveTextContent("1 King St, EC2V 8AU London, GB");
    expect(card).toHaveTextContent("gb_vat GB123456789 · verified");
    expect(card).toHaveTextContent("PO-2211");
    expect(screen.getByTestId("company-changes")).toHaveTextContent("by the customer · po reference, billing email");
    expect(screen.getByTestId("company-changes")).toHaveTextContent("at checkout · company name, address");
  });

  it("shows the stats strip with passkeys (rev 00113) and the plan and grants as entitlements", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({
        json: {
          ...account,
          passkey_count: 2,
          plan: { plan: "business", name: "Business · monthly", status: "active", monthly_cents: 29900, current_period_end: "2026-12-01T00:00:00Z" },
          grants: [{ id: "gr_1", uid: "uid_123", entitlement: "pro", ends_at: "2026-11-30T00:00:00Z", granted_by: "owner@example.com", reason: "Goodwill", created_at: "2026-11-01T00:00:00Z", status: "active" }],
        },
      }),
    });
    const stats = await screen.findByTestId("account-stats");
    expect(stats).toHaveTextContent("Passkeys2");
    expect(stats).toHaveTextContent("Owed$1.25");
    expect(screen.getByText(/uid uid_123 · 2 passkeys/)).toBeInTheDocument();
    const ents = screen.getByTestId("entitlements");
    expect(ents).toHaveTextContent("Business · monthly");
    expect(ents).toHaveTextContent("Pro grant");
    await userEvent.click(screen.getByRole("button", { name: "Grant a plan…" }));
    expect(await screen.findByRole("alertdialog", { name: "Grant Pro" })).toBeInTheDocument();
  });

  it("shows sign-in, usage and the runs, paging older runs with runs_before (rev 00114)", async () => {
    const run = (id: string, status = "SUCCEEDED") => ({ id, project_id: "p1", status, kind: "lifelike", created_at: "2026-11-03T10:00:00Z", amount_cents: 4250 });
    const { calls } = renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": ({ path }) =>
        path.includes("runs_before=r2")
          ? { json: { ...account, runs: { count: 3, items: [run("r3", "FAILED")], next_before: null } } }
          : {
              json: {
                ...account,
                account: { ...account.account, created_at: "2026-07-12T00:00:00Z" },
                runs: { count: 3, items: [run("r1"), run("r2")], next_before: "r2" },
                usage: { period: "plan", period_start: "2026-11-01T00:00:00Z", period_end: "2026-12-01T00:00:00Z", tier: "business", runs: 5, succeeded: 4, spent_cents: 11400, plan_credit_left_cents: 18800 },
                sign_in: { methods: ["apple", "passkey"], passkey_count: 2, firebase_created_at: "2026-07-12T00:00:00Z", last_sign_in_at: new Date().toISOString() },
              },
            },
    });
    const sub = await screen.findByTestId("account-subline");
    expect(sub).toHaveTextContent("Apple, passkey · 2 passkeys · since Jul 12, 2026 · last sign-in just now");
    const stats = screen.getByTestId("account-stats");
    expect(stats).toHaveTextContent("Usage this period4 / 5 runs$114.00 spent · plan period · resets Dec 1 · $188.00 credit left");
    expect(stats).toHaveTextContent("Runs3");
    const runs = screen.getByTestId("account-runs");
    expect(within(runs).getAllByRole("row")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Older runs" }));
    await waitFor(() => expect(within(runs).getAllByRole("row")).toHaveLength(4));
    expect(runs).toHaveTextContent("failed");
    expect(screen.queryByRole("button", { name: "Older runs" })).toBeNull();
    expect(calls.some((c) => c.url.includes("runs_limit=20&runs_before=r2"))).toBe(true);
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
          promo_regrants: [
            {
              id: "pr_1",
              event: "refund:in_1",
              status: "done",
              snapshot: [{ entitlement: "pro", expires_at: "2027-01-01T00:00:00Z" }],
              regranted: [{ entitlement: "pro", expires_at: "2027-01-01T00:00:00Z" }],
              created_at: "2026-11-01T00:00:00Z",
            },
          ],
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
    expect(screen.getByTestId("regrant-pr_1")).toHaveTextContent("Refund");
    expect(screen.getByTestId("regrant-pr_1")).toHaveTextContent("Done");
    expect(screen.queryByRole("button", { name: "Restore promotional grants…" })).toBeNull();
  });

  it("grants Pro for a preset with a reason, confirming with the passkey when asked", async () => {
    const wa = installWebAuthn();
    let posts = 0;
    const auth = new FakeAuth();
    const { calls } = renderApp(
      "/accounts/uid_123",
      {
        "GET /v1/admin/accounts/uid_123": () => ({ json: { ...account, grants: [] } }),
        "POST /v1/admin/accounts/uid_123/grants": ({ body }) => {
          posts++;
          if (posts === 1) return apiError(401, "reauth_required", "again", { method: "passkey" });
          const b = body as { entitlement: string; ends_at: string; reason: string };
          return { status: 201, json: { grant: grant({ id: "gr_9", entitlement: b.entitlement, ends_at: b.ends_at, reason: b.reason }) } };
        },
        ...passkeyRoutes,
      },
      auth,
    );
    expect(await screen.findByText("No grants.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Grant Pro…" }));
    const sheet = screen.getByRole("alertdialog", { name: "Grant Pro" });
    const submit = within(sheet).getByRole("button", { name: "Grant Pro" });
    expect(submit).toBeDisabled(); // reason required
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Entitlement" }));
    await userEvent.click(await screen.findByRole("option", { name: "Business" }));
    await userEvent.click(within(sheet).getByLabelText("1 week"));
    await userEvent.type(within(sheet).getByLabelText(/Reason/), "conference speaker");
    await userEvent.click(within(sheet).getByRole("button", { name: "Grant Business" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await userEvent.click(within(reauth).getByRole("button", { name: "Use your passkey" }));
    await waitFor(() => expect(posts).toBe(2));
    expect(wa.get).toHaveBeenCalledTimes(1);
    expect(auth.reauthenticate).not.toHaveBeenCalled();
    wa.uninstall();
    const body = calls.filter((c) => c.method === "POST").at(-1)!.body as { entitlement: string; ends_at: string; reason: string };
    expect(body.entitlement).toBe("business");
    expect(body.reason).toBe("conference speaker");
    const days = (Date.parse(body.ends_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(await screen.findByTestId("grant-gr_9")).toHaveTextContent("Business");
    expect(await findToast(/^Business granted until/)).toBeInTheDocument();
  });

  it("a custom end date outside 1 hour to 5 years can't be sent", async () => {
    renderApp("/accounts/uid_123", { "GET /v1/admin/accounts/uid_123": () => ({ json: account }) });
    await userEvent.click(await screen.findByRole("button", { name: "Grant Pro…" }));
    const sheet = screen.getByRole("alertdialog", { name: "Grant Pro" });
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
    const sheet = screen.getByRole("alertdialog", { name: "Grant Pro" });
    await userEvent.type(within(sheet).getByLabelText(/Reason/), "support");
    await userEvent.click(within(sheet).getByRole("button", { name: "Grant Pro" }));
    expect(await screen.findByTestId("grant-gr_f")).toHaveTextContent("Failed");
    expect(await findToast("Not granted: RevenueCat said no")).toBeInTheDocument();
  });

  it("503 rc_unavailable keeps the sheet open with a retry hint", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: account }),
      "POST /v1/admin/accounts/uid_123/grants": () => apiError(503, "rc_unavailable", "down"),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Grant Pro…" }));
    const sheet = screen.getByRole("alertdialog", { name: "Grant Pro" });
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
    const sheet = screen.getByRole("alertdialog", { name: "Revoke Pro" });
    const revoke = within(sheet).getByRole("button", { name: "Revoke" });
    expect(revoke).toBeDisabled();
    await userEvent.type(within(sheet).getByLabelText(/Reason/), "partnership ended");
    await userEvent.click(revoke);
    expect(await findToast("Revoked. Some grants will be retried tonight.")).toBeInTheDocument();
    expect(screen.getByTestId("grant-gr_1")).toHaveTextContent("Revoked");
    expect(calls.find((c) => c.method === "DELETE")!.body).toEqual({ reason: "partnership ended" });
  });

  it("restores promotional grants after a lost dispute, with a reason and a fresh sign-in", async () => {
    let posts = 0;
    const lost = {
      id: "pr_2",
      event: "dispute:dp_1",
      status: "kept_removed",
      snapshot: [{ entitlement: "pro", expires_at: "2027-03-01T00:00:00Z" }],
      case_id: "CASE-0051",
      created_at: "2026-11-01T00:00:00Z",
    };
    const wa = installWebAuthn();
    const auth = new FakeAuth();
    const { calls } = renderApp(
      "/accounts/uid_123",
      {
        ...passkeyRoutes,
        "GET /v1/admin/accounts/uid_123": () => ({ json: { ...account, promo_regrants: [lost] } }),
        "POST /v1/admin/accounts/uid_123/actions": () => {
          posts++;
          if (posts === 1) return apiError(401, "reauth_required", "again", { method: "passkey" });
          return {
            json: {
              ...account,
              promo_regrants: [{ ...lost, status: "done", outcome: "restored", restored_by: "owner@example.com", restore_note: "bank error", regranted: lost.snapshot }],
            },
          };
        },
      },
      auth,
    );
    const row = await screen.findByTestId("regrant-pr_2");
    expect(row).toHaveTextContent("Dispute");
    expect(within(row).getByRole("link", { name: "CASE-0051" })).toHaveAttribute("href", "/cases/CASE-0051");
    await userEvent.click(screen.getByRole("button", { name: "Restore promotional grants…" }));
    const sheet = screen.getByRole("alertdialog", { name: "Restore promotional grants" });
    expect(within(sheet).getByRole("button", { name: "Restore" })).toBeDisabled();
    await userEvent.type(within(sheet).getByLabelText(/Reason/), "bank error");
    await userEvent.click(within(sheet).getByRole("button", { name: "Restore" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Confirm it's you" })).getByRole("button", { name: "Use your passkey" }));
    await waitFor(() => expect(screen.getByTestId("regrant-pr_2")).toHaveTextContent("Restored by owner@example.com: bank error"));
    wa.uninstall();
    expect(calls.filter((c) => c.method === "POST").at(-1)!.body).toEqual({ action: "restore_promo_grants", note: "bank error" });
    expect(screen.queryByRole("button", { name: "Restore promotional grants…" })).toBeNull();
  });

  it("nothing to restore says so", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({
        json: { ...account, promo_regrants: [{ id: "pr_3", event: "efw:issfr_1", status: "held", created_at: "2026-11-01T00:00:00Z" }] },
      }),
      "POST /v1/admin/accounts/uid_123/actions": () => apiError(409, "nothing_to_restore", "No removed promotional grants on this account."),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Restore promotional grants…" }));
    const sheet = screen.getByRole("alertdialog", { name: "Restore promotional grants" });
    await userEvent.type(within(sheet).getByLabelText(/Reason/), "x");
    await userEvent.click(within(sheet).getByRole("button", { name: "Restore" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("No removed promotional grants on this account.");
  });

  it("409 grant_not_active says so", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: { ...account, grants: [grant()] } }),
      "DELETE /v1/admin/accounts/uid_123/grants/gr_1": () => apiError(409, "grant_not_active", "not active"),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Revoke…" }));
    const sheet = screen.getByRole("alertdialog", { name: "Revoke Pro" });
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

  it("an expired token that can't refresh ends the session", async () => {
    const auth = new FakeAuth();
    renderApp("/cases", { "GET /v1/admin/cases": () => apiError(401, "invalid_token", "expired") }, auth);
    await waitFor(() => expect(auth.reportProblem).toHaveBeenCalledWith("invalid_token"));
  });

  it("signed in: the Cases badge counts what's overdue or due today, red when something is overdue", async () => {
    renderApp("/cases", {
      "GET /v1/admin/cases": () => ({ json: { cases: [], counts: { open: 7, overdue: 1, due_today: 2 } } }),
    });
    const link = await screen.findByRole("link", { name: "Cases: 1 overdue, 2 due today" });
    expect(link).toHaveTextContent("Cases3");
    expect(link.querySelector('[title="1 overdue, 2 due today"]')).toHaveClass("text-destructive-foreground");
  });

  it("failed refunds get a red dot on Cases, and new feedback a grey badge", async () => {
    const failed = { id: "CASE-0060", type: "refund", reason: "refund_failed", mode: "auto", status: "open", opened_at: "2026-11-03T00:00:00Z", age_hours: 2, email_masked: "a•••@b.com", requested_cents: 500, last_activity_at: "2026-11-03T00:00:00Z" };
    renderApp("/cases", {
      "GET /v1/admin/cases": () => ({ json: { cases: [failed], counts: { open: 1, overdue: 0, due_today: 0 } } }),
      "GET /v1/admin/feedback": () => ({ json: { days: 7, items: [{ id: "f1", created_at: new Date().toISOString(), platform: "web", kind: "idea", message: "hi" }] } }),
      "GET /v1/admin/feedback/seen": () => ({ json: { seen_at: null, updated_at: null } }),
    });
    expect(await screen.findByRole("link", { name: "Cases, 1 failed refund" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Feedback: 1 new" })).toBeInTheDocument();
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
    expect(calls.find((c) => c.path === "/v1/admin/onboarding/headsets")!.url).toContain("days=90");
  });

  it("shows the Business/Studio setup answers by main use and team size", async () => {
    renderApp("/onboarding", {
      "GET /v1/admin/onboarding/headsets": () => ({ json: { days: 90, generated_at: "2026-11-04T00:00:00Z" } }),
      "GET /v1/admin/onboarding/business_funnel": () => ({
        json: {
          days: 90,
          answers: {
            accounts: 4,
            by_main_use: [{ main_use: "client_work", count: 3 }, { main_use: "stock", count: 1 }],
            by_team_size: [{ team_size: "2-5", count: 4 }],
          },
          generated_at: "2026-11-04T00:00:00Z",
        },
      }),
    });
    const answers = await screen.findByTestId("onboarding-setup-answers");
    expect(answers).toHaveTextContent("Client work375%");
    expect(answers).toHaveTextContent("4 accounts");
    expect(answers).toHaveTextContent("2-54100%");
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
    expect(calls.filter((c) => c.path === "/v1/admin/plans/surfaces").at(-1)!.url).toContain("days=30");
  });
});

describe("feedback (owner 2026-11-04)", () => {
  it("shows the sender's plan tier, and opening Feedback moves the console-wide seen marker (BL-29)", async () => {
    const posted: unknown[] = [];
    const { calls } = renderApp("/feedback", {
      "GET /v1/admin/feedback": () => ({
        json: { days: 30, items: [{ id: "f1", created_at: new Date(Date.now() - 60_000).toISOString(), platform: "web", kind: "idea", message: "hi", plan_tier: "business" }] },
      }),
      "GET /v1/admin/feedback/seen": () => ({ json: { seen_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" } }),
      "POST /v1/admin/feedback/seen": ({ body }) => {
        posted.push(body);
        return { json: { seen_at: (body as { seen_at: string }).seen_at } };
      },
    });
    const table = await screen.findByTestId("feedback-list");
    expect(table).toHaveTextContent("WebBusiness");
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(Date.parse((posted[0] as { seen_at: string }).seen_at)).toBeGreaterThan(Date.now() - 60_000);
    await waitFor(() => expect(calls.some((c) => c.method === "GET" && c.path === "/v1/admin/feedback/seen")).toBe(true));
    expect(screen.getByRole("link", { name: "Feedback" })).toBeInTheDocument(); // no "new" badge after the visit
  });

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
    // the page asks for 30 days (the nav badge asks for 7 on its own)
    expect(calls.some((c) => c.path === "/v1/admin/feedback" && c.url.includes("days=30"))).toBe(true);
  });
});

describe("disputes badge and banner (header)", () => {
  const day = 24 * 3600e3;
  const summary = (over: Record<string, unknown> = {}) => ({
    ...disputes,
    open: [
      { dispute_id: "dp_1", amount_cents: 2800, reason: "fraudulent", status: "needs_response", payment_intent: "pi_1", due_by: new Date(Date.now() + 2 * day).toISOString() },
      { dispute_id: "dp_2", amount_cents: 1200, reason: "fraudulent", status: "needs_response", payment_intent: "pi_2", due_by: new Date(Date.now() + 1 * day).toISOString() },
      { dispute_id: "dp_3", amount_cents: 900, reason: "general", status: "under_review", payment_intent: "pi_3", due_by: new Date(Date.now() + 1 * day).toISOString() },
      { dispute_id: "dp_4", amount_cents: 900, reason: "general", status: "needs_response", payment_intent: "pi_4", due_by: new Date(Date.now() + 10 * day).toISOString() },
    ],
    open_efws: 1,
    ...over,
  });
  const cases = { "GET /v1/admin/cases": () => ({ json: { cases: [], counts: { open: 0, overdue: 0, due_today: 0 } } }) };

  it("shows open disputes and EFWs, links to Disputes, and warns about the ones due within 3 days", async () => {
    renderApp("/cases", { ...cases, "GET /v1/admin/disputes/summary": () => ({ json: summary() }) });
    const badge = await screen.findByRole("link", { name: "Disputes: 4 disputes, 1 EFW" });
    expect(badge).toHaveTextContent("Disputes5");
    expect(badge).toHaveAttribute("href", "/disputes");
    const soonest = new Date(Date.now() + day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    expect(screen.getByText(`2 disputes need a response by ${soonest}.`)).toBeInTheDocument();
  });

  it("shows nothing for zero or an error", async () => {
    const { calls } = renderApp("/cases", { ...cases, "GET /v1/admin/disputes/summary": () => ({ json: summary({ open: [], open_efws: 0 }) }) });
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/admin/disputes/summary")).toBe(true));
    expect(screen.getByRole("link", { name: "Disputes" })).toBeInTheDocument();
    expect(screen.queryByText(/need a response|needs a response/)).toBeNull();
  });

  it("an error stays quiet", async () => {
    const { calls } = renderApp("/cases", { ...cases, "GET /v1/admin/disputes/summary": () => apiError(500, "internal", "boom") });
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/admin/disputes/summary")).toBe(true));
    expect(screen.getByRole("link", { name: "Disputes" })).toBeInTheDocument();
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("refreshes every 60 s and when the window gets focus", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let n = 0;
      renderApp("/cases", {
        ...cases,
        "GET /v1/admin/disputes/summary": () => {
          n++;
          return { json: summary({ open: n === 1 ? [] : summary().open, open_efws: 0 }) };
        },
      });
      await waitFor(() => expect(n).toBe(1));
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => expect(n).toBe(2));
      expect(await screen.findByRole("link", { name: "Disputes: 4 disputes" })).toBeInTheDocument();
      fireEvent.focus(window);
      await waitFor(() => expect(n).toBe(3));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Pro credit (gateway 00159, PRO-07)", () => {
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
    id: "pcg_1",
    month: 0,
    period_start: "2026-11-07T00:00:00Z",
    period_end: "2026-12-07T00:00:00Z",
    cents: 2000,
    kind: "pro_monthly",
    source: "app_store",
    period_type: "normal",
    state: "granted",
    granted_at: "2026-11-07T09:00:00Z",
    ...over,
  });

  it("lists each month's credit with its state, newest first; a removed month says what was taken back", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({
        json: {
          ...account,
          pro_credit: {
            grants: [
              grant({ id: "pcg_0", month: 0, period_start: "2026-10-07T00:00:00Z", period_end: "2026-11-07T00:00:00Z", state: "removed", removed_cents: 1240, removed_at: "2026-10-20T00:00:00Z", period_type: "trial" }),
              grant({ id: "pcg_1", month: 1 }),
              grant({ id: "pcg_2", month: 2, period_start: "2026-12-07T00:00:00Z", period_end: "2027-01-07T00:00:00Z", kind: "pro_lifetime", cents: 1000, source: "web", state: "granting" }),
            ],
            refunds: 1,
            refund_flag: false,
          },
        },
      }),
    });
    const panel = await screen.findByTestId("pro-credit");
    expect(panel).toHaveTextContent("1 Pro refund");
    const rows = within(screen.getByTestId("pro-credit-table")).getAllByTestId(/^pro-credit-pcg_/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(["pro-credit-pcg_2", "pro-credit-pcg_1", "pro-credit-pcg_0"]);
    expect(rows[0]).toHaveTextContent("Pro Lifetime");
    expect(rows[0]).toHaveTextContent("$10.00");
    expect(rows[0]).toHaveTextContent("Granting");
    expect(rows[1]).toHaveTextContent("Pro Monthly");
    expect(rows[1]).toHaveTextContent("App Store");
    expect(rows[1]).toHaveTextContent("Granted");
    expect(rows[2]).toHaveTextContent("trial");
    expect(rows[2]).toHaveTextContent("Removed");
    expect(rows[2]).toHaveTextContent("$12.40 taken back");
    expect(screen.queryByTestId("pro-refund-flag")).toBeNull();
  });

  it("flags a repeat refunder above the table", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({
        json: { ...account, pro_credit: { grants: [], refunds: 2, refund_flag: true } },
      }),
    });
    expect(await screen.findByTestId("pro-refund-flag")).toHaveTextContent(
      "Repeat refunder: this account refunded Pro 2 times.",
    );
    expect(screen.getByText("No Pro credit granted.")).toBeInTheDocument();
  });

  it("an older gateway without pro_credit shows no section", async () => {
    renderApp("/accounts/uid_123", { "GET /v1/admin/accounts/uid_123": () => ({ json: account }) });
    expect(await screen.findByTestId("grants")).toBeInTheDocument();
    expect(screen.queryByTestId("pro-credit")).toBeNull();
  });
});

describe("the 48-hour deletion on an account (gateway 00166)", () => {
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
  const deletion = (over: Record<string, unknown> = {}) => ({
    uid: "uid_123",
    state: "pending",
    requested_at: "2026-11-07T09:00:00Z",
    delete_after: "2026-11-09T09:00:00Z",
    balance_confirmed: false,
    source: "web",
    blocked: false,
    attempts: 0,
    ...over,
  });

  it("shows when it goes, and Cancel deletion keeps the account", async () => {
    const { calls } = renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: { ...account, deletion: deletion() } }),
      "POST /v1/admin/accounts/uid_123/actions": () => ({
        json: { ...account, deletion: deletion({ state: "cancelled", cancelled_at: "2026-11-07T10:00:00Z", cancelled_by: "admin:owner@example.com" }) },
      }),
    });
    const panel = await screen.findByTestId("deletion");
    expect(screen.getByText("Deletion pending")).toBeInTheDocument();
    expect(within(panel).getByTestId("deletion-state")).toHaveTextContent("Pending");
    expect(panel).toHaveTextContent(/· web/i);
    await userEvent.click(within(panel).getByRole("button", { name: "Cancel deletion…" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel deletion" }));
    await waitFor(() => expect(within(screen.getByTestId("deletion")).getByTestId("deletion-state")).toHaveTextContent("Cancelled"));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ action: "cancel_deletion" });
    expect(screen.queryByText("Deletion pending")).toBeNull();
    expect(within(screen.getByTestId("deletion")).queryByRole("button", { name: "Process now…" })).toBeNull();
  });

  it("Process now deletes it; an answer with only the deletion keeps the page", async () => {
    const { calls } = renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: { ...account, deletion: deletion({ blocked: true, blocked_reason: "run_in_progress", attempts: 2 }) } }),
      "POST /v1/admin/accounts/uid_123/actions": () => ({
        json: { deletion: deletion({ state: "done", processed_at: "2026-11-07T10:00:00Z", processed_by: "admin:owner@example.com", outcome: "deleted" }) },
      }),
    });
    const panel = await screen.findByTestId("deletion");
    expect(within(panel).getByTestId("deletion-state")).toHaveTextContent("Blocked");
    expect(within(panel).getByTestId("deletion-blocked")).toHaveTextContent("2 attempts");
    await userEvent.click(within(panel).getByRole("button", { name: "Process now…" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete now" }));
    await waitFor(() => expect(within(screen.getByTestId("deletion")).getByTestId("deletion-state")).toHaveTextContent("Deleted"));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ action: "process_deletion_now" });
    // the rest of the page stays
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("jane@example.com");
  });

  it("no deletion, no panel", async () => {
    renderApp("/accounts/uid_123", { "GET /v1/admin/accounts/uid_123": () => ({ json: account }) });
    expect(await screen.findByTestId("grants")).toBeInTheDocument();
    expect(screen.queryByTestId("deletion")).toBeNull();
  });
});

describe("Deletions page (gateway 00166)", () => {
  it("lists pending deletions soonest first, links each account, and switches state", async () => {
    const pending = {
      deletions: [
        { uid: "uid_a", state: "pending", requested_at: "2026-11-07T09:00:00Z", delete_after: "2026-11-09T09:00:00Z", source: "web", blocked: false, attempts: 0 },
        { uid: "uid_b", state: "pending", requested_at: "2026-11-07T10:00:00Z", delete_after: "2026-11-09T10:00:00Z", source: "app", blocked: true, blocked_reason: "run_in_progress", attempts: 3 },
      ],
    };
    const cancelled = {
      deletions: [{ uid: "uid_c", state: "cancelled", requested_at: "2026-11-05T09:00:00Z", delete_after: "2026-11-07T09:00:00Z", cancelled_at: "2026-11-06T09:00:00Z", cancelled_by: "user" }],
    };
    const { calls } = renderApp("/deletions", {
      "GET /v1/admin/deletions": ({ path }) => ({ json: path.includes("state=cancelled") ? cancelled : pending }),
    });
    const table = await screen.findByTestId("deletions");
    const rows = within(table).getAllByTestId(/^deletion-uid_/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(["deletion-uid_a", "deletion-uid_b"]);
    expect(within(rows[0]).getByRole("link", { name: "uid_a" })).toHaveAttribute("href", "/accounts/uid_a");
    expect(rows[0]).toHaveTextContent("Pending");
    expect(rows[1]).toHaveTextContent("Blocked");
    expect(rows[1]).toHaveTextContent("3 attempts");
    await userEvent.click(screen.getByRole("combobox", { name: "State" }));
    await userEvent.click(await screen.findByRole("option", { name: "Cancelled" }));
    expect(await screen.findByTestId("deletion-uid_c")).toHaveTextContent("Cancelled");
    expect(calls.some((c) => c.url.includes("/v1/admin/deletions?state=cancelled"))).toBe(true);
  });

  it("says so when no account waits", async () => {
    renderApp("/deletions", { "GET /v1/admin/deletions": () => ({ json: { deletions: null } }) });
    expect(await screen.findByText("No accounts waiting to be deleted.")).toBeInTheDocument();
  });
});
