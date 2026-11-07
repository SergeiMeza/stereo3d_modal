import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { casePage, casesResponse } from "../test/fixtures";
import { apiError, renderApp } from "../test/harness";

describe("cases list (A1)", () => {
  it("shows skeleton rows, then counts and rows in the gateway's order", async () => {
    renderApp("/cases", { "GET /v1/admin/cases": () => ({ json: casesResponse }) });
    expect(screen.getAllByTestId("skeleton-row").length).toBeGreaterThan(0);
    const counts = await screen.findByLabelText("Case counts");
    expect(counts).toHaveTextContent("7 open");
    expect(counts).toHaveTextContent("1 overdue");
    expect(counts).toHaveTextContent("2 due today");
    const rows = screen.getAllByTestId("case-row");
    expect(within(rows[0]).getByText("CASE-0051")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/dispute due/)).toBeInTheDocument();
    expect(within(rows[1]).getByText("$49.72")).toBeInTheDocument();
    expect(within(rows[1]).getByText("1d 4h")).toBeInTheDocument();
  });

  it("asks the gateway for the tab and filters", async () => {
    const { calls } = renderApp("/cases", { "GET /v1/admin/cases": () => ({ json: casesResponse }) });
    await screen.findByText("CASE-0042");
    await userEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Mode" }));
    await userEvent.click(await screen.findByRole("option", { name: "manual" }));
    await waitFor(() => expect(calls.filter((c) => c.path !== "/v1/admin/disputes/summary").at(-1)!.url).toContain("tab=waiting&mode=manual"));
  });

  it("shows the empty state", async () => {
    renderApp("/cases", { "GET /v1/admin/cases": () => ({ json: { cases: null, counts: { open: 0, overdue: 0, due_today: 0 } } }) });
    expect(await screen.findByText("No open cases.")).toBeInTheDocument();
  });

  it("shows the error state and retries", async () => {
    let fail = true;
    renderApp("/cases", {
      "GET /v1/admin/cases": () => (fail ? apiError(502, "cases_unavailable", "Couldn't load cases.") : { json: casesResponse }),
    });
    expect(await screen.findByText("Couldn't load cases.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("CASE-0042")).toBeInTheDocument();
  });

  it("opens a case from its row", async () => {
    renderApp("/cases", {
      "GET /v1/admin/cases": () => ({ json: casesResponse }),
      "GET /v1/admin/cases/CASE-0042": () => apiError(404, "not_found", "case not found"),
      "GET /v1/admin/mail-previews": () => ({ json: { mails: [] } }),
    });
    await userEvent.click(await screen.findByText("CASE-0042"));
    expect(await screen.findByText("No case CASE-0042.")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/cases/CASE-0042");
  });
});

describe("cases list keys and preview (BL-29 redesign B)", () => {
  it("J / K and the arrows move the selection and the preview; D opens the decision; typing in search doesn't", async () => {
    const { calls } = renderApp("/cases", {
      "GET /v1/admin/cases": () => ({ json: casesResponse }),
      "GET /v1/admin/cases/CASE-0042": () => ({ json: casePage() }),
    });
    const list = await screen.findByTestId("case-list");
    const preview = screen.getByRole("region", { name: "Case preview" });
    expect(within(preview).getByRole("heading")).toHaveTextContent("CASE-0051");
    const links = within(list).getAllByRole("link");
    links[0].focus();
    await userEvent.keyboard("j");
    expect(links[1]).toHaveFocus();
    expect(links[1]).toHaveAttribute("aria-current", "true");
    expect(within(preview).getByRole("heading")).toHaveTextContent("CASE-0042");
    // the preview comes from the row (uid since rev 00114): no request per selection
    expect(within(preview).getByRole("link", { name: "j•••@gmail.com" })).toHaveAttribute("href", "/accounts/uid_123");
    expect(calls.some((c) => /^\/v1\/admin\/cases\/CASE-/.test(c.path))).toBe(false);
    await userEvent.keyboard("{ArrowUp}");
    expect(links[0]).toHaveFocus();
    await userEvent.type(screen.getByLabelText("Search cases"), "jk");
    expect(links[0]).toHaveAttribute("aria-current", "true");
    links[1].focus();
    await userEvent.keyboard("e");
    expect(window.location.pathname).toBe("/accounts/uid_123");
    window.history.back();
  });

  it("D opens the selected case with the decision sheet", async () => {
    const { calls } = renderApp("/cases", {
      "GET /v1/admin/cases": () => ({ json: casesResponse }),
      "GET /v1/admin/cases/CASE-0042": () => ({ json: casePage() }),
    });
    const list = await screen.findByTestId("case-list");
    const links = within(list).getAllByRole("link");
    links[1].focus();
    await userEvent.keyboard("d");
    expect(window.location.pathname + window.location.search).toBe("/cases/CASE-0042?decide=1");
    expect(calls.some((c) => c.path === "/v1/admin/cases/CASE-0042")).toBe(true);
  });
});

describe("cases preview: excerpt and runs (BL-29, gateway cf7c121)", () => {
  const withFields = {
    ...casesResponse,
    cases: casesResponse.cases!.map((c, i) =>
      i === 0 ? { ...c, message_excerpt: "The 3D effect is too weak in the second half. Can I get a refund?…", run_ids: ["c_7Hk2Qm", "c_3Pw9Lx"] } : c,
    ),
  };

  it("shows the customer's message excerpt and the run ids; a run id opens ⌘K's run lookup", async () => {
    const { calls } = renderApp("/cases", {
      "GET /v1/admin/cases": () => ({ json: withFields }),
      "GET /v1/admin/runs/c_7Hk2Qm": () => ({
        json: { run: { id: "c_7Hk2Qm", uid: "uid_9", project_id: "p1", status: "SUCCEEDED", created_at: "2026-11-03T21:40:00Z", amount_cents: 4250, currency: "usd", kind: "lifelike", method: "card" } },
      }),
    });
    const preview = await screen.findByRole("region", { name: "Case preview" });
    expect(within(preview).getByTestId("preview-message")).toHaveTextContent("The 3D effect is too weak");
    await userEvent.click(within(preview).getByRole("button", { name: "Look up run c_7Hk2Qm" }));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    expect(within(dialog).getByRole("combobox", { name: "Search" })).toHaveValue("c_7Hk2Qm");
    expect(await within(dialog).findByRole("option", { name: /c_7Hk2Qm · lifelike/ })).toBeInTheDocument();
    expect(calls.some((c) => /^\/v1\/admin\/cases\/CASE-/.test(c.path))).toBe(false);
  });

  it("an older gateway without the fields shows neither, and fetches nothing extra", async () => {
    const { calls } = renderApp("/cases", { "GET /v1/admin/cases": () => ({ json: casesResponse }) });
    const preview = await screen.findByRole("region", { name: "Case preview" });
    expect(within(preview).queryByTestId("preview-message")).toBeNull();
    expect(within(preview).queryByTestId("preview-runs")).toBeNull();
    expect(calls.some((c) => /^\/v1\/admin\/cases\/CASE-/.test(c.path))).toBe(false);
  });
});

describe("refund policy 2026-11-07: no balance refund at account closure", () => {
  it("the Reason filter no longer offers closure balance; an old closure case still lists and opens", async () => {
    const old = {
      ...casesResponse.cases![1],
      id: "CASE-0007",
      type: "balance_refund",
      reason: "closure_balance",
    };
    renderApp("/cases", {
      "GET /v1/admin/cases": () => ({ json: { ...casesResponse, cases: [old, ...casesResponse.cases!] } }),
      "GET /v1/admin/cases/CASE-0007": () => apiError(404, "not_found", "case not found"),
      "GET /v1/admin/mail-previews": () => ({ json: { mails: [] } }),
    });
    await screen.findAllByText("CASE-0007");
    const row = screen.getAllByTestId("case-row").find((r) => r.textContent?.includes("CASE-0007"))!;
    expect(within(row).getByText(/closure balance/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Reason" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toContain("topup withdrawal");
    expect(options).not.toContain("closure balance");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(row).getByText("CASE-0007"));
    expect(window.location.pathname).toBe("/cases/CASE-0007");
  });
});
