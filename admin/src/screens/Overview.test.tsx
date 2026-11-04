import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { buildLanes } from "../lib/lanes";
import type { CaseRow } from "../lib/types";
import { disputes } from "../test/fixtures";
import { renderApp } from "../test/harness";

const H = 3600e3;
const NOW = Date.parse("2026-11-04T09:00:00");
const iso = (ms: number) => new Date(ms).toISOString();
const row = (over: Partial<CaseRow>): CaseRow => ({
  id: "CASE-1",
  type: "refund",
  reason: "delivered_run",
  mode: "manual",
  status: "open",
  opened_at: iso(NOW - 10 * H),
  age_hours: 10,
  email_masked: "m•••@example.com",
  requested_cents: 4250,
  last_activity_at: iso(NOW - H),
  ...over,
});

describe("lanes (Now / Today / This week)", () => {
  it("puts overdue, failed refunds and EFWs in Now, today's deadlines in Today, the rest of the week in This week", () => {
    const lanes = buildLanes(
      [
        row({ id: "CASE-A", deadline_at: iso(NOW - 6 * H) }),
        row({ id: "CASE-B", reason: "refund_failed", deadline_at: iso(NOW + 40 * H) }),
        row({ id: "CASE-C", type: "efw", reason: "efw" }),
        row({ id: "CASE-D", deadline_at: iso(NOW + 3 * H) }),
        row({ id: "CASE-E", deadline_at: iso(NOW + 4 * 24 * H) }),
        row({ id: "CASE-F", deadline_at: iso(NOW + 20 * 24 * H) }),
        row({ id: "CASE-G" }),
      ],
      { ...disputes, open: [{ dispute_id: "dp_9", amount_cents: 2800, reason: "fraudulent", status: "needs_response", payment_intent: "pi", due_by: iso(NOW + 3 * 24 * H) }] },
      NOW,
    );
    const by = (l: string) => lanes.filter((x) => x.lane === l).map((x) => x.id);
    expect(by("now")).toEqual(expect.arrayContaining(["CASE-A", "CASE-B", "CASE-C"]));
    expect(by("today")).toEqual(["CASE-D"]);
    expect(by("week")).toEqual(["dp_9", "CASE-E"]);
    expect(lanes.find((l) => l.id === "CASE-A")!.due).toBe("6 h overdue");
    expect(lanes.map((l) => l.id)).not.toContain("CASE-F");
    expect(lanes.map((l) => l.id)).not.toContain("CASE-G");
  });

  it("doesn't list a dispute twice when its case is open", () => {
    const lanes = buildLanes([row({ id: "CASE-0051", type: "dispute", dispute_due: iso(NOW + 2 * 24 * H) })], disputes, NOW);
    expect(lanes.filter((l) => l.caseId === "CASE-0051")).toHaveLength(1);
  });
});

describe("Needs attention (Overview)", () => {
  const soon = new Date(Date.now() + 2 * H).toISOString();
  const later = new Date(Date.now() + 3 * 24 * H).toISOString();
  const cases = {
    cases: [
      row({ id: "CASE-1039", type: "efw", reason: "efw", requested_cents: 8900, email_masked: "j•••@example.com" }),
      row({ id: "CASE-1042", deadline_at: soon }),
      row({ id: "CASE-1041", type: "dispute", reason: "dispute", dispute_due: later }),
    ],
    counts: { open: 3, overdue: 0, due_today: 1 },
  };
  const routes = {
    "GET /v1/admin/cases": () => ({ json: cases }),
    "GET /v1/admin/disputes/summary": () => ({ json: { ...disputes, open: [], open_efws: 1 } }),
    "GET /v1/admin/plans/surfaces": () => ({
      json: { days: 7, generated_at: "x", placements: [{ placement: "quote", views: 9, viewers: 9, dismissals: 0, clicks: 2, conversions: 2, conversions_by_product: { business: 2 }, click_rate: 0.2, conversion_rate: 0.2 }], unattributed: { conversions: 1, by_product: { studio: 1 } },
        starts: [
          { uid: "u1", email: "kim.visual@example.com", product: "business", plan: "business_monthly", source: "checkout", price_cents: 29900, started_at: "2026-11-04T08:00:00Z", placement: "quote" },
          { uid: "u2", email: "app.user@example.com", product: "pro", plan: null, source: "app_store", price_cents: null, started_at: "2026-11-03T08:00:00Z", placement: null },
        ] },
    }),
    "GET /v1/admin/passkey-adoption": () => ({
      json: { accounts_with_passkey: 41, passkeys: 57, sign_ins: { "7d": { passkey: 30, google: 70 }, "30d": { passkey: 100, google: 300 } }, generated_at: "x" },
    }),
  };

  it("leads with Next up, then the lanes, plan starts and passkey adoption", async () => {
    renderApp("/", routes);
    const next = await screen.findByRole("region", { name: "Next up" });
    expect(next).toHaveTextContent("CASE-1039");
    expect(next).toHaveTextContent("Early fraud warning on $89.00");
    expect(within(next).getByRole("button", { name: "Decide on $89.00" })).toBeInTheDocument();
    expect(within(screen.getByTestId("lane-now")).getByText("CASE-1039")).toBeInTheDocument();
    expect(within(screen.getByTestId("lane-today")).getByText("CASE-1042")).toBeInTheDocument();
    expect(within(screen.getByTestId("lane-week")).getByText("CASE-1041")).toBeInTheDocument();
    const starts = await screen.findByTestId("plan-starts");
    expect(starts).toHaveTextContent("kim.visual@example.comBusiness · $299.00");
    expect(starts).toHaveTextContent("app.user@example.comPro · App Store");
    expect(within(starts).getByRole("link", { name: "kim.visual@example.com" })).toHaveAttribute("href", "/accounts/u1");
    expect(screen.getByText("+$299.00")).toBeInTheDocument();
    expect(await screen.findByTestId("passkey-adoption")).toHaveTextContent("41");
    expect(screen.getByTestId("passkey-adoption")).toHaveTextContent("30%");
    // the nav total: Now + Today
    expect(screen.getByRole("link", { name: "Needs attention: 2 need you today" })).toBeInTheDocument();
  });

  it("Skip for now moves to the next item; Decide opens the case with the decision sheet", async () => {
    renderApp("/", { ...routes, "GET /v1/admin/cases/CASE-1042": () => ({ status: 404, json: { error: "not_found", message: "x" } }) });
    const next = await screen.findByRole("region", { name: "Next up" });
    await userEvent.click(within(next).getByRole("button", { name: "Skip for now" }));
    expect(screen.getByRole("region", { name: "Next up" })).toHaveTextContent("CASE-1042");
    await userEvent.click(within(screen.getByRole("region", { name: "Next up" })).getByRole("button", { name: /^Decide/ }));
    expect(window.location.pathname + window.location.search).toBe("/cases/CASE-1042?decide=1");
  });

  it("says when nothing needs attention", async () => {
    renderApp("/", { "GET /v1/admin/cases": () => ({ json: { cases: [], counts: { open: 0, overdue: 0, due_today: 0 } } }) });
    expect(await screen.findByText("Nothing needs you right now.")).toBeInTheDocument();
  });
});

describe("Grants page (BL-29)", () => {
  it("lists every admin grant with the account linked, and says it's admin grants only", async () => {
    const { calls } = renderApp("/grants", {
      "GET /v1/admin/grants": () => ({
        json: {
          grants: [
            { id: "gr_1", uid: "u1", email: "kim@example.com", kind: "business", granted_by: "owner@example.com", start: "2026-11-01T00:00:00Z", end: "2026-11-30T00:00:00Z", status: "active", reason: "Goodwill" },
            { id: "gr_2", uid: "u2", email: "alex@example.com", kind: "pro", granted_by: "owner@example.com", start: "2026-09-01T00:00:00Z", end: "2026-12-01T00:00:00Z", status: "revoked", reason: "Creator", revoked_at: "2026-10-03T00:00:00Z", revoked_by: "owner@example.com", revoke_reason: "refund on CASE-0912" },
          ],
        },
      }),
    });
    const table = await screen.findByTestId("all-grants");
    expect(within(table).getByRole("link", { name: "kim@example.com" })).toHaveAttribute("href", "/accounts/u1");
    expect(screen.getByTestId("all-grant-gr_1")).toHaveTextContent("Active");
    expect(screen.getByTestId("all-grant-gr_2")).toHaveTextContent("refund on CASE-0912");
    expect(screen.getByText(/Admin grants only/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/v1/admin/grants")).toBe(true);
  });
});
