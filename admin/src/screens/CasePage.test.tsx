import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { casePage, mailPreviews } from "../test/fixtures";
import { apiError, FakeAuth, renderApp } from "../test/harness";

const base = (page = casePage()) => ({
  "GET /v1/admin/cases/CASE-0042": () => ({ json: page }),
  "GET /v1/admin/mail-previews": () => ({ json: mailPreviews }),
});

/** Decisions live in the decision sheet (BL-29 redesign B): open it, pick one. */
async function decide(name: string | RegExp) {
  await userEvent.click(await screen.findByRole("button", { name: /^Decide/ }));
  const sheet = await screen.findByRole("dialog", { name: /^Decide CASE-/ });
  await userEvent.click(within(sheet).getByRole("button", { name }));
}

describe("case page (A2)", () => {
  it("shows the header, the per-run table and the evidence", async () => {
    renderApp("/cases/CASE-0042", base());
    expect(await screen.findByRole("heading", { name: "CASE-0042" })).toBeInTheDocument();
    expect(screen.getByText("Visa •••• 4242")).toBeInTheDocument();
    const run = screen.getByText("Kyoto walk · 3D video · 4K").closest("tr")!;
    expect(within(run).getAllByText("$49.72")).toHaveLength(2);
    expect(within(run).getByText("Partly · 3 of 4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decide · up to $49.72" })).toBeEnabled();
    expect(screen.getByText(/not recorded yet/)).toBeInTheDocument();
    // Timeline newest first.
    const items = screen.getAllByRole("listitem").filter((li) => li.closest('[data-testid="timeline"]'));
    expect(items[0]).toHaveTextContent("Part 4 failed.");
  });

  it("renders customer text as plain text and drops unsafe links", async () => {
    const { container } = renderApp("/cases/CASE-0042", base());
    await screen.findByText(/please refund/);
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('a[href="https://evil.example"]')).toBeNull();
    expect(screen.getByRole("link", { name: /PaymentIntent/ })).toHaveAttribute("href", "https://dashboard.stripe.com/test/payments/pi_1");
    expect(screen.getByRole("link", { name: /PaymentIntent/ })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("approve: confirm sheet shows the amount per run and the mail, and sends the maximum it showed", async () => {
    const after = casePage({}, { status: "refund_pending" });
    const { calls } = renderApp("/cases/CASE-0042", {
      ...base(),
      "POST /v1/admin/cases/CASE-0042/actions": () => ({ json: after }),
    });
    await decide("Approve $49.72");
    const dialog = screen.getByRole("alertdialog", { name: "Refund $49.72 to Visa •••• 4242" });
    expect(within(dialog).getByText("Refundable after this").nextSibling).toHaveTextContent("$0.00");
    expect(within(dialog).getByText(/Mail E6 · Stereo3D Studio: we refunded \$49.72 \(CASE-0042\)/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ action: "approve", expected_max_cents: 4972 });
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    expect(screen.getAllByText("Refund pending").length).toBeGreaterThan(0);
  });

  it("amount_changed: reloads the case and asks for a fresh confirm", async () => {
    let reloaded = false;
    let posts = 0;
    const smaller = casePage({
      max_refundable_cents: 3729,
      runs: [{ ...casePage().runs![0], refunded_cents: 1243, refundable_cents: 3729 }],
    });
    const { calls } = renderApp("/cases/CASE-0042", {
      "GET /v1/admin/cases/CASE-0042": () => {
        const page = reloaded ? smaller : casePage();
        return { json: page };
      },
      "GET /v1/admin/mail-previews": () => ({ json: mailPreviews }),
      "POST /v1/admin/cases/CASE-0042/actions": ({ body }) => {
        posts++;
        if (posts === 1) {
          reloaded = true;
          return apiError(409, "amount_changed", "The amount changed to $37.29.", { max_refundable_cents: 3729 });
        }
        expect(body).toEqual({ action: "approve", expected_max_cents: 3729 });
        return { json: smaller };
      },
    });
    await decide("Approve $49.72");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/The amount changed to \$37.29/)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Refund $37.29 to Visa •••• 4242" })).toBeInTheDocument();
    expect(posts).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("reauth_required {method: google}: a Google sign-in, then the action once more", async () => {
    let posts = 0;
    const auth = new FakeAuth();
    renderApp(
      "/cases/CASE-0042",
      {
        ...base(),
        "POST /v1/admin/cases/CASE-0042/actions": () => {
          posts++;
          return posts === 1 ? apiError(401, "reauth_required", "confirm it's you again", { method: "google" }) : { json: casePage() };
        },
      },
      auth,
    );
    await decide("Approve $49.72");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await userEvent.click(within(reauth).getByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(posts).toBe(2));
    expect(auth.reauthenticate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("cancelling the re-auth says nothing moved", async () => {
    renderApp("/cases/CASE-0042", {
      ...base(),
      "POST /v1/admin/cases/CASE-0042/actions": () => apiError(401, "reauth_required", "again"),
    });
    await decide("Approve $49.72");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await userEvent.click(within(reauth).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Not confirmed. Nothing was charged or refunded.")).toBeInTheDocument();
  });

  it("partial: validates amounts per run and prefills pro rata of failed parts", async () => {
    const { calls } = renderApp("/cases/CASE-0042", {
      ...base(),
      "POST /v1/admin/cases/CASE-0042/actions": () => ({ json: casePage() }),
    });
    await decide("Partial…");
    const dialog = screen.getByRole("alertdialog");
    const input = within(dialog).getByLabelText("Amount for c_7Hk2Qm");
    await userEvent.clear(input);
    await userEvent.type(input, "60");
    expect(within(dialog).getByText(/at most that run's refundable amount/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Pro rata of failed parts" }));
    expect(input).toHaveValue("12.43");
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Refund $12.43 to Visa •••• 4242");
    expect(within(dialog).getByText("Refundable after this").nextSibling).toHaveTextContent("$37.29");
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      action: "partial",
      items: { c_7Hk2Qm: 1243 },
      expected_max_cents: 4972,
    });
  });

  it("deny: template choice and the E10 text", async () => {
    const { calls } = renderApp("/cases/CASE-0042", {
      ...base(),
      "POST /v1/admin/cases/CASE-0042/actions": () => ({ json: casePage({}, { status: "closed", open: false }) }),
    });
    await decide("Deny…");
    const dialog = screen.getByRole("alertdialog", { name: "Deny refund" });
    await userEvent.click(within(dialog).getByText(/Mail E10/));
    expect(within(dialog).getByText(/delivered as described/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByLabelText("Other (write the text)"));
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Text for the customer"), "We can't refund this one.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      action: "deny",
      template: "other",
      text: "We can't refund this one.",
    });
  });

  it("shows the gateway's failure without claiming money moved", async () => {
    renderApp("/cases/CASE-0042", {
      ...base(),
      "POST /v1/admin/cases/CASE-0042/actions": () =>
        apiError(502, "action_failed", "That didn't work: stripe down. Nothing was charged or refunded."),
    });
    await decide("Approve $49.72");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That didn't work: stripe down. Nothing was charged or refunded.");
  });

  it("waive case: Waive $X with owed per run", async () => {
    const page = casePage(
      {
        runs: [{ conversion_id: "c_3Pw9Lx", label: "Market day · Preview · 4K", state: "SUCCEEDED", price_cents: 100, delivered: "yes", paid_from: "owed", refundable_cents: 0, owed_cents: 100 }],
        max_refundable_cents: 0,
        actions: ["waive", "deny", "note", "refresh_evidence", "close"],
      },
      { id: "CASE-0042", type: "waive", reason: "unpaid_run" },
    );
    renderApp("/cases/CASE-0042", base(page));
    await decide("Waive $1.00");
    const dialog = screen.getByRole("alertdialog", { name: "Waive $1.00" });
    expect(within(dialog).getByText("Owed after this").nextSibling).toHaveTextContent("$0.00");
    expect(within(dialog).getByText(/we won't charge you \$1.00/)).toBeInTheDocument();
  });

  it("dispute on a refunded charge leads with counter with refund proof", async () => {
    const page = casePage(
      {
        actions: ["accept_dispute", "counter_dispute", "counter_with_refund_proof", "note", "refresh_evidence", "close"],
        hints: ["Already refunded $12.43 on 2 Nov 2026: counter with the refund proof."],
        refunds: [{ id: "r1", case_id: "CASE-0040", pi: "pi_1", charge_id: "ch_1", items: null, total_cents: 1243, status: "succeeded", source: "gateway", k: 1, created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" }],
      },
      { type: "dispute", reason: "dispute", dispute: { id: "dp_1", amount_cents: 4972, reason: "fraudulent", status: "needs_response", funds_withdrawn: true, due_by: "2026-11-09T00:00:00Z" } },
    );
    renderApp("/cases/CASE-0042", base(page));
    await userEvent.click(await screen.findByRole("button", { name: /^Decide/ }));
    const sheet = await screen.findByRole("dialog", { name: "Decide CASE-0042" });
    const btn = within(sheet).getByRole("button", { name: "Counter with refund proof" });
    expect(btn).toHaveAttribute("data-variant", "default");
    expect(screen.getByText(/counter with the refund proof\./)).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("?decide=1 opens the decision sheet; money confirms mention the passkey step", async () => {
    renderApp("/cases/CASE-0042?decide=1", base());
    const sheet = await screen.findByRole("dialog", { name: "Decide CASE-0042" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Approve $49.72" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Refund $49.72 to Visa •••• 4242" });
    expect(within(confirm).getByTestId("passkey-note")).toHaveTextContent(/you'll be asked for it when you confirm/);
  });

  it("adds a note", async () => {
    const { calls } = renderApp("/cases/CASE-0042", {
      ...base(),
      "POST /v1/admin/cases/CASE-0042/actions": () => ({ json: casePage() }),
    });
    await userEvent.type(await screen.findByLabelText("Add a note"), "Checked the logs.");
    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ action: "note", text: "Checked the logs." }));
  });

  it("closed cases offer no decisions", async () => {
    renderApp("/cases/CASE-0042", base(casePage({ actions: ["note"] }, { status: "closed", open: false, result: "refunded" })));
    expect(await screen.findByText("Closed · refunded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Decide/ })).toBeNull();
    expect(screen.getByText("No decisions on this case now.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });

  it("waiting for the run: banner with Stop run now", async () => {
    const page = casePage({ banners: ["Waiting for the run to finish."], actions: ["stop_run", "note", "refresh_evidence", "close"] }, { status: "waiting_for_run" });
    renderApp("/cases/CASE-0042", base(page));
    const banner = (await screen.findByText("Waiting for the run to finish.")).closest('[data-slot="alert"]')!;
    await userEvent.click(within(banner as HTMLElement).getByRole("button", { name: "Stop run now" }));
    expect(screen.getByRole("alertdialog", { name: "Stop the run now" })).toBeInTheDocument();
  });
});

describe("closed cases and follow-ups (00107)", () => {
  it("renders an owner's promo restore in the timeline", async () => {
    const page = casePage(
      {
        events: [
          {
            id: "promo_restored_x",
            at: "2026-11-04T06:00:00Z",
            who: "owner@example.com",
            kind: "promo_restored",
            text: "promotional Pro restored by owner@example.com: bank error",
            data: {
              type: "promo_restored",
              by: "owner@example.com",
              at: "2026-11-04T06:00:00Z",
              reason: "bank error",
              restore_id: "promo_restored_x",
              regranted: [
                { entitlement: "pro", ends_at: "2026-12-31T00:00:00Z" },
                { entitlement: "pro", ends_at: null },
              ],
              skipped: [{ entitlement: "pro", ends_at: "2026-10-01T00:00:00Z" }],
            },
          },
        ],
      },
      { status: "closed", open: false },
    );
    renderApp("/cases/CASE-0042", base(page));
    const ev = await screen.findByTestId("promo-restored");
    expect(ev).toHaveTextContent("Promotional grants restored by owner@example.com: bank error");
    expect(ev).toHaveTextContent(/Given back: Pro until .*2026, Pro, no end date/);
    expect(ev).toHaveTextContent(/Skipped \(already ended\): Pro until/);
  });

  it("a note on a closed case says to reopen it", async () => {
    renderApp("/cases/CASE-0042", {
      ...base(casePage({ actions: ["note"] }, { status: "closed", open: false })),
      "POST /v1/admin/cases/CASE-0042/actions": () => apiError(409, "case_closed", "case is closed"),
    });
    await userEvent.type(await screen.findByLabelText("Add a note"), "late info");
    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reopen the case to add notes.");
  });

  it("a decision on a closed case says to reopen it", async () => {
    renderApp("/cases/CASE-0042", {
      ...base(),
      "POST /v1/admin/cases/CASE-0042/actions": () => apiError(409, "case_closed", "case is closed"),
    });
    await decide("Deny…");
    const dialog = screen.getByRole("alertdialog", { name: "Deny refund" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByText("Reopen the case to add notes or decisions.")).toBeInTheDocument();
  });

  it("links a follow-up to the closed case and back", async () => {
    renderApp("/cases/CASE-0042", base(casePage({}, { follow_up_of: "CASE-0031" })));
    const link = within(await screen.findByTestId("follow-up-of")).getByRole("link", { name: "CASE-0031" });
    expect(link).toHaveAttribute("href", "/cases/CASE-0031");
  });

  it("the closed case lists its follow-ups", async () => {
    const page = casePage({}, { status: "closed", open: false, follow_up_ids: ["CASE-0049", "CASE-0050"] });
    renderApp("/cases/CASE-0042", base(page));
    const row = await screen.findByTestId("follow-ups");
    expect(row).toHaveTextContent("Follow-ups: CASE-0049, CASE-0050");
    expect(within(row).getByRole("link", { name: "CASE-0050" })).toHaveAttribute("href", "/cases/CASE-0050");
  });
});
