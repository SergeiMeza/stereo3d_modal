import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { casesResponse } from "../test/fixtures";
import { apiError, renderApp } from "../test/harness";

describe("cases list (A1)", () => {
  it("shows skeleton rows, then counts and rows in the gateway's order", async () => {
    renderApp("/cases", { "GET /v1/admin/cases": () => ({ json: casesResponse }) });
    expect(screen.getAllByTestId("skeleton-row").length).toBeGreaterThan(0);
    const counts = await screen.findByLabelText("Case counts");
    expect(counts).toHaveTextContent("7 open");
    expect(counts).toHaveTextContent("1 overdue");
    expect(counts).toHaveTextContent("2 due today");
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("CASE-0051")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/dispute due/)).toBeInTheDocument();
    expect(within(rows[1]).getByText("$49.72")).toBeInTheDocument();
    expect(within(rows[1]).getByText("1d 4h")).toBeInTheDocument();
  });

  it("asks the gateway for the tab and filters", async () => {
    const { calls } = renderApp("/cases", { "GET /v1/admin/cases": () => ({ json: casesResponse }) });
    await screen.findByText("CASE-0042");
    await userEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await userEvent.selectOptions(screen.getByLabelText("Mode"), "manual");
    await waitFor(() => expect(calls.at(-1)!.url).toContain("tab=waiting&mode=manual"));
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
