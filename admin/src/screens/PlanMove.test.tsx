import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { casePage } from "../test/fixtures";
import { apiError, findToast, renderApp } from "../test/harness";
import { installWebAuthn, requestOptions } from "../test/webauthn";
import type { CasePage, PlanMovePreview } from "../lib/types";

const passkeyRoutes = {
  "POST /v1/admin/session/options": () => ({ json: { options: { publicKey: requestOptions }, expires_at: "2026-11-04T10:05:00Z" } }),
  "POST /v1/admin/session/verify": () => ({ json: { session: "sess_2", expires_at: "2099-01-01T00:00:00Z", last_assertion_at: "2026-11-04T10:00:00Z" } }),
};

const plan = {
  plan: "studio",
  name: "Studio",
  status: "active",
  active: true,
  cancel_at_period_end: true,
  current_period_end: "2026-12-01T00:00:00Z",
};

function account(over: Record<string, unknown> = {}, accountOver: Record<string, unknown> = {}) {
  return {
    account: { uid: "uid_123", email: "jane@example.com", stripe_customer_id: "cus_1", blocked: false, ...accountOver },
    billing_state: { flow_state: "ok", sheet_only: false, lifetime_paid_cents: 0 },
    owed_cents: 0,
    balance: null,
    methods: null,
    cases: null,
    charges: null,
    refunds: null,
    ledger: null,
    plan,
    ...over,
  };
}

const moveCase = (over: Partial<CasePage["case"]> = {}): CasePage =>
  casePage(
    { runs: [], actions: ["offer_plan_move", "cancel_plan_move", "note", "close"], max_refundable_cents: 0 },
    { id: "CASE-0100", type: "support", reason: "plan_move", source: "support", customer_text: "", related: {}, ...over },
  );

const preview = (over: Partial<PlanMovePreview> = {}): PlanMovePreview => ({
  from_uid: "uid_123",
  to_uid: "uid_bob",
  blockers: [],
  stays: ["usage_already_used", "balance", "app_store_purchases", "admin_grants", "past_runs_and_files"],
  plan: "studio",
  plan_id: "studio",
  subscription_id: "sub_1",
  period_end: "2026-12-01T00:00:00Z",
  renews: false,
  carry_cents: 12000,
  moves: ["plan", "app_access", "current_usage"],
  ...over,
});

const hits = {
  json: {
    accounts: [
      { uid: "uid_123", email: "jane@example.com", plan: "studio" },
      { uid: "uid_bob", email: "bob@example.com", plan: null },
    ],
  },
};

async function pickAndCheck(sheet: HTMLElement) {
  await userEvent.type(within(sheet).getByLabelText("Receiving account"), "bob");
  const list = await within(sheet).findByRole("list", { name: "Accounts found" });
  expect(within(list).queryByText("jane@example.com")).toBeNull(); // the account itself isn't offered
  await userEvent.click(within(list).getByRole("button", { name: /bob@example.com/ }));
  const check = within(sheet).getByRole("button", { name: "Check the move" });
  await userEvent.type(within(sheet).getByLabelText("How was ownership checked?"), "short");
  expect(check).toBeDisabled(); // at least 10 characters
  await userEvent.type(within(sheet).getByLabelText("How was ownership checked?"), " but now long enough: same card, mailed from both");
  await userEvent.click(check);
}

describe("Move plan (RP-05)", () => {
  it("shows only for an active web plan on a live account", async () => {
    const { unmount } = renderApp("/accounts/uid_123", { "GET /v1/admin/accounts/uid_123": () => ({ json: account() }) });
    expect(await screen.findByRole("button", { name: "Move plan…" })).toBeInTheDocument();
    unmount();
    const r2 = renderApp("/accounts/uid_123", { "GET /v1/admin/accounts/uid_123": () => ({ json: account({ plan: null }) }) });
    expect(await screen.findByRole("button", { name: "Grant a plan…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move plan…" })).toBeNull();
    r2.unmount();
    renderApp("/accounts/uid_123", { "GET /v1/admin/accounts/uid_123": () => ({ json: account({}, { deleted: true }) }) });
    expect(await screen.findByRole("button", { name: "Grant a plan…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move plan…" })).toBeNull();
  });

  it("search, ownership, preview, the passkey, then Offer; the case opens", async () => {
    const wa = installWebAuthn();
    let offers = 0;
    const { calls } = renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: account() }),
      "GET /v1/admin/accounts": () => hits,
      "POST /v1/admin/cases": () => ({ json: { cases: [moveCase()] } }),
      "GET /v1/admin/cases/CASE-0100/plan-move/preview": () => ({ json: preview() }),
      "POST /v1/admin/cases/CASE-0100/actions": () => {
        offers++;
        if (offers === 1) return apiError(401, "reauth_required", "again", { method: "passkey" });
        return {
          json: moveCase({
            plan_move: {
              from_uid: "uid_123",
              to_uid: "uid_bob",
              subscription_id: "sub_1",
              plan: "studio",
              period_end: "2026-12-01T00:00:00Z",
              state: "offered",
              offered_by: "owner@example.com",
              offered_at: "2026-11-06T06:00:00Z",
              expires_at: "2099-11-13T06:00:00Z",
            },
          }),
        };
      },
      "GET /v1/admin/cases/CASE-0100": () => ({ json: moveCase() }),
      "GET /v1/admin/mail-previews": () => ({ json: { previews: [] } }),
      ...passkeyRoutes,
    });
    await userEvent.click(await screen.findByRole("button", { name: "Move plan…" }));
    const sheet = screen.getByRole("dialog", { name: "Move plan" });
    const offer = within(sheet).getByRole("button", { name: "Offer the move" });
    expect(offer).toBeDisabled();
    await pickAndCheck(sheet);

    const shown = await within(sheet).findByTestId("move-preview");
    expect(shown).toHaveTextContent("ends");
    expect(within(sheet).getByTestId("move-moves")).toHaveTextContent("This period's usage left ($120.00)");
    expect(within(sheet).getByTestId("move-stays")).toHaveTextContent("App Store purchases");
    expect(within(sheet).getByTestId("passkey-note")).toBeInTheDocument();
    const opened = calls.find((c) => c.method === "POST" && c.path === "/v1/admin/cases")!.body as Record<string, string>;
    expect(opened).toEqual({ uid: "uid_123", reason: "plan_move", text: "short but now long enough: same card, mailed from both" });
    expect(calls.find((c) => c.path.endsWith("/plan-move/preview"))!.url).toContain("to=uid_bob");

    await userEvent.click(offer);
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await userEvent.click(within(reauth).getByRole("button", { name: "Use your passkey" }));
    await waitFor(() => expect(offers).toBe(2));
    wa.uninstall();
    const body = calls.filter((c) => c.path === "/v1/admin/cases/CASE-0100/actions").at(-1)!.body as Record<string, string>;
    expect(body.action).toBe("offer_plan_move");
    expect(body.to_uid).toBe("uid_bob");
    expect(body.expected_subscription_id).toBe("sub_1");
    expect(await findToast("Move offered. The receiving account has 7 days to accept it.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "CASE-0100" })).toBeInTheDocument();
  });

  it("blockers in plain words; Offer stays off", async () => {
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: account({ plan: { ...plan, cancel_at_period_end: false } }) }),
      "GET /v1/admin/accounts": () => hits,
      "POST /v1/admin/cases": () => ({ json: { cases: [moveCase()] } }),
      "GET /v1/admin/cases/CASE-0100/plan-move/preview": () => ({
        json: preview({ blockers: ["plan_renewing", "target_has_plan"], renews: true }),
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Move plan…" }));
    const sheet = screen.getByRole("dialog", { name: "Move plan" });
    await pickAndCheck(sheet);
    const blockers = await within(sheet).findByTestId("move-blockers");
    expect(blockers).toHaveTextContent("The plan still renews. The customer cancels it first");
    expect(blockers).toHaveTextContent("The receiving account has a plan of its own.");
    expect(within(sheet).getByRole("button", { name: "Offer the move" })).toBeDisabled();
    expect(within(sheet).queryByTestId("passkey-note")).toBeNull();
  });

  it("409 subscription_changed: says so and checks again", async () => {
    let previews = 0;
    renderApp("/accounts/uid_123", {
      "GET /v1/admin/accounts/uid_123": () => ({ json: account() }),
      "GET /v1/admin/accounts": () => hits,
      "POST /v1/admin/cases": () => ({ json: { cases: [moveCase()] } }),
      "GET /v1/admin/cases/CASE-0100/plan-move/preview": () => {
        previews++;
        return { json: preview() };
      },
      "POST /v1/admin/cases/CASE-0100/actions": () =>
        apiError(409, "subscription_changed", "The account's plan changed.", { subscription_id: "sub_2" }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Move plan…" }));
    const sheet = screen.getByRole("dialog", { name: "Move plan" });
    await pickAndCheck(sheet);
    await within(sheet).findByTestId("move-preview");
    await userEvent.click(within(sheet).getByRole("button", { name: "Offer the move" }));
    expect(await within(sheet).findByText("The account's plan changed. Look at the preview again.")).toBeInTheDocument();
    await waitFor(() => expect(previews).toBe(2));
  });
});

const offered = (over: Partial<NonNullable<CasePage["case"]["plan_move"]>> = {}) => ({
  from_uid: "uid_123",
  to_uid: "uid_bob",
  subscription_id: "sub_1",
  plan: "studio",
  period_end: "2026-12-01T00:00:00Z",
  state: "offered",
  offered_by: "owner@example.com",
  offered_at: "2026-11-06T06:00:00Z",
  expires_at: "2099-11-13T06:00:00Z",
  ...over,
});

describe("the plan move on its case (RP-05)", () => {
  const base = { "GET /v1/admin/mail-previews": () => ({ json: { previews: [] } }) };

  it("offered: its state, and Cancel move withdraws it; then a new offer can be made", async () => {
    let cancels = 0;
    const { calls } = renderApp("/cases/CASE-0100", {
      ...base,
      "GET /v1/admin/cases/CASE-0100": () => ({ json: moveCase({ plan_move: offered() }) }),
      "POST /v1/admin/cases/CASE-0100/actions": () => {
        cancels++;
        return { json: moveCase({ plan_move: offered({ state: "cancelled" }) }) };
      },
    });
    const panel = await screen.findByTestId("plan-move");
    expect(within(panel).getByTestId("plan-move-state")).toHaveTextContent("Offered");
    expect(within(panel).getByTestId("plan-move-facts")).toHaveTextContent("uid_bob");
    expect(within(panel).getByTestId("plan-move-facts")).toHaveTextContent("Expires");
    // the move's actions live in the panel, not in Decide
    expect(screen.getByText("No decisions on this case now.")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Offer a move…" })).toBeNull();
    await userEvent.click(within(panel).getByRole("button", { name: "Cancel move…" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Cancel the move?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel move" }));
    await waitFor(() => expect(cancels).toBe(1));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ action: "cancel_plan_move" });
    expect(await findToast("Move cancelled.")).toBeInTheDocument();
    expect(within(panel).getByTestId("plan-move-state")).toHaveTextContent("Cancelled");
    expect(within(panel).getByRole("button", { name: "Offer a move…" })).toBeInTheDocument();
  });

  it("an offer past its 7 days reads expired; done shows no actions", async () => {
    const { unmount } = renderApp("/cases/CASE-0100", {
      ...base,
      "GET /v1/admin/cases/CASE-0100": () => ({ json: moveCase({ plan_move: offered({ expires_at: "2020-01-01T00:00:00Z" }) }) }),
    });
    let panel = await screen.findByTestId("plan-move");
    expect(within(panel).getByTestId("plan-move-state")).toHaveTextContent("Expired");
    expect(within(panel).queryByRole("button", { name: "Cancel move…" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Offer a move…" })).toBeInTheDocument();
    unmount();
    renderApp("/cases/CASE-0100", {
      ...base,
      "GET /v1/admin/cases/CASE-0100": () => ({
        json: moveCase({ plan_move: offered({ state: "done", accepted_at: "2026-11-07T00:00:00Z", done_at: "2026-11-07T00:01:00Z" }) }),
      }),
    });
    panel = await screen.findByTestId("plan-move");
    expect(within(panel).getByTestId("plan-move-state")).toHaveTextContent("Done");
    expect(within(panel).getByTestId("plan-move-facts")).toHaveTextContent("Accepted");
    expect(within(panel).queryByRole("button")).toBeNull();
  });

  it("Offer a move… on the case uses that case: no new case is opened", async () => {
    const { calls } = renderApp("/cases/CASE-0100", {
      ...base,
      "GET /v1/admin/cases/CASE-0100": () => ({ json: moveCase() }),
      "GET /v1/admin/accounts": () => hits,
      "GET /v1/admin/cases/CASE-0100/plan-move/preview": () => ({ json: preview() }),
      "POST /v1/admin/cases/CASE-0100/actions": () => ({ json: moveCase({ plan_move: offered() }) }),
    });
    const panel = await screen.findByTestId("plan-move");
    expect(within(panel).getByText("No move offered yet.")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Offer a move…" }));
    const sheet = screen.getByRole("dialog", { name: "Move plan" });
    await pickAndCheck(sheet);
    await within(sheet).findByTestId("move-preview");
    await userEvent.click(within(sheet).getByRole("button", { name: "Offer the move" }));
    // Sonner's store outlives a test: an earlier test's toast can still be listed
    const toasts = await screen.findAllByText("Move offered. The receiving account has 7 days to accept it.", {
      selector: "[data-sonner-toast] [data-title]",
    });
    expect(toasts.length).toBeGreaterThan(0);
    await waitFor(() => expect(within(panel).getByTestId("plan-move-state")).toHaveTextContent("Offered"));
    expect(calls.some((c) => c.method === "POST" && c.path === "/v1/admin/cases")).toBe(false);
  });
});
