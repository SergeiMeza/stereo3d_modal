import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { casePage, casesResponse } from "../test/fixtures";
import { noSession, renderApp } from "../test/harness";

const routes = {
  "GET /v1/admin/cases": ({ path }: { path: string }) =>
    path.includes("q=") ? { json: { cases: casesResponse.cases!.slice(1), counts: casesResponse.counts } } : { json: casesResponse },
  "GET /v1/admin/cases/CASE-0042": () => ({ json: casePage() }),
  "GET /v1/admin/accounts": ({ path }: { path: string }) =>
    path.includes("q=jane") ? { json: { accounts: [{ uid: "uid_123", email: "jane@example.com", created_at: "2026-07-12T00:00:00Z", plan: "business" }] } } : { json: { accounts: [] } },
};

describe("⌘K search (BL-29 redesign B)", () => {
  it("opens from the header and with ⌘K, and jumps straight to a case id", async () => {
    renderApp("/cases", routes);
    await screen.findByText("CASE-0042");
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(dialog).getByRole("combobox", { name: "Search" }), "case-0042");
    await userEvent.click(within(dialog).getByRole("option", { name: /Open CASE-0042/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/cases/CASE-0042"));
  });

  it("an email finds its accounts (GET /v1/admin/accounts) and its cases", async () => {
    const { calls } = renderApp("/cases", routes);
    await userEvent.click(await screen.findByRole("button", { name: "Search accounts, cases, runs" }));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(dialog).getByRole("combobox", { name: "Search" }), "jane@example.com");
    expect(await within(dialog).findByRole("option", { name: /CASE-0042/ })).toBeInTheDocument();
    const acct = await within(dialog).findByRole("option", { name: /jane@example\.com.*business · since Jul 12, 2026/ });
    expect(calls.some((c) => c.path === "/v1/admin/cases" && c.url.includes("q=jane%40example.com") && c.url.includes("tab=all"))).toBe(true);
    expect(calls.some((c) => c.path === "/v1/admin/accounts" && c.url.includes("q=jane%40example.com"))).toBe(true);
    expect(calls.some((c) => c.path === "/v1/admin/cases/CASE-0042")).toBe(false);
    await userEvent.click(acct);
    await waitFor(() => expect(window.location.pathname).toBe("/accounts/uid_123"));
  });

  it("uid: opens the account; plain keys typed in a field never open it", async () => {
    renderApp("/cases", routes);
    const search = await screen.findByLabelText("Search cases");
    await userEvent.type(search, "k/");
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "/" });
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(dialog).getByRole("combobox", { name: "Search" }), "uid:abc123");
    await userEvent.click(within(dialog).getByRole("option", { name: /Open the account/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/accounts/abc123"));
  });

  it("a run id finds the run (GET /v1/admin/runs/{id}) and opens its account; a 404 shows nothing", async () => {
    const { calls } = renderApp("/cases", {
      ...routes,
      "GET /v1/admin/runs/c_7Hk2Qm": () => ({
        json: { run: { id: "c_7Hk2Qm", uid: "uid_9", project_id: "p1", status: "SUCCEEDED", created_at: "2026-11-03T21:40:00Z", amount_cents: 4250, currency: "usd", kind: "lifelike", method: "card" } },
      }),
      "GET /v1/admin/runs/zzzz": () => ({ status: 404, json: { error: "run_not_found", message: "no run" } }),
    });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    const input = within(dialog).getByRole("combobox", { name: "Search" });
    await userEvent.type(input, "zzzz");
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/admin/runs/zzzz")).toBe(true));
    expect(within(dialog).queryByRole("group", { name: "Runs" })).toBeNull();
    await userEvent.clear(input);
    await userEvent.type(input, "c_7Hk2Qm");
    const opt = await within(dialog).findByRole("option", { name: /c_7Hk2Qm · lifelike · SUCCEEDED/ });
    expect(opt).toHaveTextContent("$42.50");
    expect(opt).not.toHaveTextContent("Paid");
    await userEvent.click(opt);
    await waitFor(() => expect(window.location.pathname).toBe("/accounts/uid_9"));
  });

  it("a run the card paid in its own currency shows both amounts (owner 2026-11-07)", async () => {
    renderApp("/cases", {
      ...routes,
      "GET /v1/admin/runs/c_jpy0001": () => ({
        json: { run: { id: "c_jpy0001", uid: "uid_9", status: "SUCCEEDED", created_at: "2026-11-03T21:40:00Z", amount_cents: 4250, currency: "usd", kind: "lifelike", presentment: { amount_minor: 6390, currency: "jpy" } } },
      }),
    });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(dialog).getByRole("combobox", { name: "Search" }), "c_jpy0001");
    const opt = await within(dialog).findByRole("option", { name: /c_jpy0001/ });
    expect(opt).toHaveTextContent("Paid ¥6,390 (US$42.50)");
  });

  it("isn't there before sign-in", () => {
    renderApp("/cases", {}, undefined, noSession());
    expect(screen.getByRole("button", { name: "Use your passkey" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
  });
});
