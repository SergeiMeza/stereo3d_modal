/**
 * The 48-hour deletion at sign-in (owner 2026-11-07, gateway 00166):
 * the blocking prompt, Keep my account, Delete it (sign out only), and
 * what a frozen action says. Mock mode only: never a real account.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DeletionPrompt } from "@/components/auth/DeletionPrompt";
import { deleteAfterDay, pendingDeletionMessage } from "@/lib/accountDeletion";
import { GatewayClient, GatewayError } from "@/lib/api/client";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/projects",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  replace.mockClear();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const AFTER = "2099-11-09T14:05:00Z";

function renderPrompt() {
  return render(
    <AuthProvider>
      <button type="button">Something in the app</button>
      <DeletionPrompt />
    </AuthProvider>,
  );
}

describe("sign-in while deletion waits", () => {
  it("nothing to ask when no deletion waits", async () => {
    renderPrompt();
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByTestId("deletion-prompt")).toBeNull();
  });

  it("asks first and blocks the app; Keep my account cancels the deletion", async () => {
    mockDb.billing.accountDeletion = { delete_after: AFTER, requested_at: "2099-11-07T14:05:00Z" };
    renderPrompt();
    const prompt = await screen.findByTestId("deletion-prompt");
    expect(prompt.textContent).toContain(`Your account is set to be deleted on ${deleteAfterDay(AFTER)}.`);
    // modal: the page behind isn't reachable
    expect(screen.queryByRole("button", { name: "Something in the app" })).toBeNull();
    fireEvent.keyDown(prompt, { key: "Escape" });
    expect(screen.getByTestId("deletion-prompt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep my account" }));
    await waitFor(() => expect(screen.queryByTestId("deletion-prompt")).toBeNull());
    expect(mockDb.billing.accountDeletion).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("Delete it only signs out; the deletion keeps its time", async () => {
    mockDb.billing.accountDeletion = { delete_after: AFTER, requested_at: "2099-11-07T14:05:00Z" };
    renderPrompt();
    await screen.findByTestId("deletion-prompt");
    fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(mockDb.billing.accountDeletion?.delete_after).toBe(AFTER);
  });
});

describe("a frozen action (409 account_pending_deletion)", () => {
  it("reads a plain message with the time", async () => {
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: async () => "t",
      fetchFn: (async () =>
        new Response(
          JSON.stringify({ success: false, error: "account_pending_deletion", message: "frozen", details: { delete_after: AFTER } }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
    });
    const e = await client.getLimits().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GatewayError);
    expect((e as GatewayError).message).toBe(pendingDeletionMessage(AFTER));
    expect((e as GatewayError).message).toMatch(/^Your account is set to be deleted on .+\. Keep your account to do this\.$/);
    expect(pendingDeletionMessage(undefined)).toBe("Your account is set to be deleted. Keep your account to do this.");
  });
});
