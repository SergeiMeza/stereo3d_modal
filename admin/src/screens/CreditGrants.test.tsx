import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { apiError, FakeAuth, findToast, renderApp } from "../test/harness";
import { installWebAuthn, requestOptions } from "../test/webauthn";

/**
 * Grant credit (owner 2026-11-07, gateway 00178). Fake gateway only:
 * staging shares the production sign-in, so no real account is touched.
 */

const passkeyRoutes = {
  "POST /v1/admin/session/options": () => ({ json: { options: { publicKey: requestOptions }, expires_at: "2026-11-07T10:05:00Z" } }),
  "POST /v1/admin/session/verify": () => ({ json: { session: "sess_2", expires_at: "2099-01-01T00:00:00Z", last_assertion_at: "2026-11-07T10:00:00Z" } }),
};

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
  id: "cg_1",
  uid: "uid_123",
  amount_cents: 2500,
  reason: "support_goodwill",
  reason_text: null,
  expires_at: "2027-02-05T10:00:00Z",
  over_cap: false,
  admin: "owner@example.com",
  request_id: "req-00000001",
  notify_user: false,
  message: null,
  mail_state: null,
  state: "active",
  unspent_cents: 1800,
  revoked_cents: 0,
  revoked_at: null,
  revoked_by: null,
  created_at: "2026-11-07T10:00:00Z",
  ...over,
});

type Body = Record<string, unknown>;

function preview(body: Body, cap = 50000) {
  const amount = body.amount_cents as number;
  return {
    json: {
      amount_cents: amount,
      cap_cents: cap,
      over_cap: amount > cap,
      expires_at: body.expires_days === null ? null : "2027-02-05T10:00:00Z",
      balance_before_cents: 1200,
      balance_after_cents: 1200 + amount,
    },
  };
}

describe("Grant credit (gateway 00178)", () => {
  it("previews the balance, mails with the message, and grants once after the fresh sign-in", async () => {
    const wa = installWebAuthn();
    const auth = new FakeAuth();
    const posts: Body[] = [];
    const { calls } = renderApp(
      "/accounts/uid_123",
      {
        "GET /v1/admin/accounts/uid_123": () => ({ json: account }),
        "GET /v1/admin/accounts/uid_123/credit-grants": () => ({ json: { grants: [] } }),
        "POST /v1/admin/accounts/uid_123/credit-grants/preview": ({ body }) => preview(body as Body),
        "POST /v1/admin/accounts/uid_123/credit-grants": ({ body }) => {
          posts.push(body as Body);
          if (posts.length === 1) return apiError(401, "reauth_required", "again", { method: "passkey" });
          const b = body as Body;
          return { json: { grant: grant({ id: "cg_9", amount_cents: b.amount_cents, reason: b.reason, notify_user: true, mail_state: "dry_run", unspent_cents: b.amount_cents }), balance_after: { balance_cents: 3700, credits: [] }, replay: false } };
        },
        ...passkeyRoutes,
      },
      auth,
    );
    expect(await screen.findByText("No credit granted.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Grant credit…" }));
    const sheet = screen.getByRole("alertdialog", { name: "Grant credit" });
    expect(sheet).toHaveTextContent("jane@example.com");
    expect(within(sheet).getByRole("button", { name: "Grant credit" })).toBeDisabled();
    await userEvent.type(within(sheet).getByLabelText(/Amount/), "25");
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Reason" }));
    await userEvent.click(await screen.findByRole("option", { name: "Promo" }));
    // 90 days by default; the preview shows before and after
    expect(within(sheet).getByLabelText("In 90 days")).toBeChecked();
    const pv = await within(sheet).findByTestId("credit-preview");
    expect(pv).toHaveTextContent("Balance now$12.00");
    expect(pv).toHaveTextContent("After the grant$37.00");
    await userEvent.click(within(sheet).getByLabelText(/Email the user/));
    const msg = within(sheet).getByLabelText(/Message/);
    await userEvent.clear(msg);
    await userEvent.type(msg, "Sorry about the wait.");
    await userEvent.click(within(sheet).getByRole("button", { name: "Grant $25.00" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await userEvent.click(within(reauth).getByRole("button", { name: "Use your passkey" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    wa.uninstall();
    // the same request_id both times: granted once
    expect(posts[0].request_id).toBe(posts[1].request_id);
    expect(String(posts[1].request_id).length).toBeGreaterThanOrEqual(8);
    expect(posts[1]).toMatchObject({ amount_cents: 2500, reason: "promo", expires_days: 90, notify_user: true, message: "Sorry about the wait." });
    expect(posts[1].confirm_over_cap).toBeUndefined();
    const row = await screen.findByTestId("credit-grant-cg_9");
    expect(row).toHaveTextContent("$25.00");
    expect(row).toHaveTextContent("Promo");
    expect(row).toHaveTextContent("Mail dry run");
    expect(await findToast("$25.00 of credit granted.")).toBeInTheDocument();
    // the account reloads for its new balance
    expect(calls.filter((c) => c.method === "GET" && c.path === "/v1/admin/accounts/uid_123").length).toBeGreaterThanOrEqual(2);
  });

  it("above the cap: a second confirmation, then confirm_over_cap", async () => {
    const posts: Body[] = [];
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: account }),
      "GET /v1/admin/accounts/uid_123/credit-grants": () => ({ json: { grants: [] } }),
      "POST /v1/admin/accounts/uid_123/credit-grants/preview": ({ body }) => preview(body as Body),
      "POST /v1/admin/accounts/uid_123/credit-grants": ({ body }) => {
        posts.push(body as Body);
        return { json: { grant: grant({ id: "cg_big", amount_cents: 75000, over_cap: true, unspent_cents: 75000 }), balance_after: null, replay: false } };
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Grant credit…" }));
    const sheet = screen.getByRole("alertdialog", { name: "Grant credit" });
    await userEvent.type(within(sheet).getByLabelText(/Amount/), "750");
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Reason" }));
    await userEvent.click(await screen.findByRole("option", { name: "Refund as credit" }));
    await userEvent.click(within(sheet).getByLabelText("No end"));
    const cap = await within(sheet).findByTestId("credit-over-cap");
    expect(cap).toHaveTextContent("$750.00 is above the $500.00 cap. Grant it anyway.");
    expect(within(sheet).getByTestId("credit-preview")).toHaveTextContent("EndsNo end");
    const go = within(sheet).getByRole("button", { name: "Grant $750.00" });
    expect(go).toBeDisabled();
    await userEvent.click(within(cap).getByRole("checkbox"));
    await userEvent.click(go);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ amount_cents: 75000, reason: "refund_as_credit", expires_days: null, confirm_over_cap: true, notify_user: false });
    expect(await screen.findByTestId("credit-grant-cg_big")).toHaveTextContent("above the cap");
  });

  it("Other needs words; a custom end sends its days", async () => {
    const posts: Body[] = [];
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: account }),
      "GET /v1/admin/accounts/uid_123/credit-grants": () => ({ json: { grants: [] } }),
      "POST /v1/admin/accounts/uid_123/credit-grants/preview": ({ body }) => preview(body as Body),
      "POST /v1/admin/accounts/uid_123/credit-grants": ({ body }) => {
        posts.push(body as Body);
        return { json: { grant: grant({ id: "cg_o", reason: "other", reason_text: "beta tester" }), balance_after: null, replay: false } };
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Grant credit…" }));
    const sheet = screen.getByRole("alertdialog", { name: "Grant credit" });
    await userEvent.type(within(sheet).getByLabelText(/Amount/), "10");
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Reason" }));
    await userEvent.click(await screen.findByRole("option", { name: "Other" }));
    await within(sheet).findByTestId("credit-preview");
    expect(within(sheet).getByRole("button", { name: "Grant $10.00" })).toBeDisabled();
    await userEvent.type(within(sheet).getByLabelText(/What for/), "beta tester");
    await userEvent.click(within(sheet).getByLabelText("After…"));
    const d = within(sheet).getByLabelText(/^Days/);
    await userEvent.clear(d);
    await userEvent.type(d, "14");
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Grant $10.00" })).toBeEnabled());
    await userEvent.click(within(sheet).getByRole("button", { name: "Grant $10.00" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ reason: "other", reason_text: "beta tester", expires_days: 14 });
    expect(await screen.findByTestId("credit-grant-cg_o")).toHaveTextContent("Other: beta tester");
  });

  it("Revoke unspent removes only what's left", async () => {
    let revoked = 0;
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: account }),
      "GET /v1/admin/accounts/uid_123/credit-grants": () => ({
        json: { grants: [grant(), grant({ id: "cg_spent", unspent_cents: 0, created_at: "2026-11-06T10:00:00Z" })] },
      }),
      "POST /v1/admin/accounts/uid_123/credit-grants/cg_1/revoke": () => {
        revoked++;
        return {
          json: {
            grant: grant({ state: "revoked", unspent_cents: 0, revoked_cents: 1800, revoked_by: "owner@example.com", revoked_at: "2026-11-07T11:00:00Z" }),
            revoked_cents: 1800,
            balance_after: null,
          },
        };
      },
    });
    const row = await screen.findByTestId("credit-grant-cg_1");
    expect(row).toHaveTextContent("$18.00");
    // a spent grant has nothing to revoke
    expect(within(screen.getByTestId("credit-grant-cg_spent")).queryByRole("button")).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Revoke unspent…" }));
    const sheet = screen.getByRole("alertdialog", { name: "Revoke unspent credit" });
    expect(sheet).toHaveTextContent("Removes the $18.00 still unspent");
    await userEvent.click(within(sheet).getByRole("button", { name: "Remove $18.00" }));
    await waitFor(() => expect(revoked).toBe(1));
    expect(await screen.findByTestId("credit-grant-cg_1")).toHaveTextContent("Revoked");
    expect(screen.getByTestId("credit-grant-cg_1")).toHaveTextContent("$18.00 removed by owner@example.com");
    expect(await findToast("$18.00 removed.")).toBeInTheDocument();
  });
});

describe("Credits page (gateway 00178)", () => {
  it("monthly totals and every grant, linked to its account", async () => {
    renderApp("/credits", {
      "GET /v1/admin/credit-grants": () => ({
        json: {
          grants: [grant({ unspent_cents: null }), grant({ id: "cg_2", uid: "uid_456", state: "revoked", revoked_cents: 500, reason: "other", reason_text: "test drive" })],
          months: [{ month: "2026-11", grants: 2, cents: 5000, revoked_cents: 500 }],
          truncated: false,
        },
      }),
    });
    const month = await screen.findByTestId("credit-month-2026-11");
    expect(month).toHaveTextContent("Nov 2026");
    expect(month).toHaveTextContent("$50.00");
    expect(month).toHaveTextContent("−$5.00");
    expect(month).toHaveTextContent("$45.00");
    expect(within(screen.getByTestId("all-credit-cg_1")).getByRole("link", { name: "uid_123" })).toHaveAttribute("href", "/accounts/uid_123");
    expect(screen.getByTestId("all-credit-cg_2")).toHaveTextContent("Other: test drive");
    expect(screen.getByTestId("all-credit-cg_2")).toHaveTextContent("$5.00 removed");
    expect(screen.getByRole("link", { name: "Credits" })).toBeInTheDocument();
  });
});
