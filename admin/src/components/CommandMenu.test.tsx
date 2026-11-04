import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { casePage, casesResponse } from "../test/fixtures";
import { noSession, renderApp } from "../test/harness";

const routes = {
  "GET /v1/admin/cases": ({ path }: { path: string }) =>
    path.includes("q=") ? { json: { cases: casesResponse.cases!.slice(1), counts: casesResponse.counts } } : { json: casesResponse },
  "GET /v1/admin/cases/CASE-0042": () => ({ json: casePage() }),
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

  it("an email finds its cases and the account through the newest case", async () => {
    const { calls } = renderApp("/cases", routes);
    await userEvent.click(await screen.findByRole("button", { name: "Search accounts, cases, runs" }));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(dialog).getByRole("combobox", { name: "Search" }), "jane@example.com");
    expect(await within(dialog).findByRole("option", { name: /CASE-0042/ })).toBeInTheDocument();
    const acct = await within(dialog).findByRole("option", { name: /from its newest case/ });
    expect(calls.some((c) => c.path === "/v1/admin/cases" && c.url.includes("q=jane%40example.com") && c.url.includes("tab=all"))).toBe(true);
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

  it("isn't there before sign-in", () => {
    renderApp("/cases", {}, undefined, noSession());
    expect(screen.getByRole("button", { name: "Use your passkey" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
  });
});
