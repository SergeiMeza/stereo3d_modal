import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminSession, memoryStorage, SESSION_MARGIN_MS } from "./adminSession";

afterEach(() => vi.useRealTimers());

describe("AdminSession (ADR 0135)", () => {
  it("keeps expires_at and last_assertion_at with the token in storage", () => {
    const store = memoryStorage();
    const s = new AdminSession(store);
    s.set("sess_1", { expires_at: "2099-01-01T00:00:00Z", last_assertion_at: "2026-11-04T10:00:00Z" });
    const again = new AdminSession(store);
    expect(again.get()).toBe("sess_1");
    expect(again.details()).toEqual({ token: "sess_1", expires_at: "2099-01-01T00:00:00Z", last_assertion_at: "2026-11-04T10:00:00Z" });
  });

  it("ends the session a little before expires_at, so the passkey step shows first", () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-11-04T10:00:00Z");
    vi.setSystemTime(now);
    const s = new AdminSession(memoryStorage());
    const changed = vi.fn();
    s.subscribe(changed);
    s.set("sess_1", { expires_at: new Date(now + 10 * 60_000).toISOString() });
    vi.advanceTimersByTime(10 * 60_000 - SESSION_MARGIN_MS - 1000);
    expect(s.get()).toBe("sess_1");
    vi.advanceTimersByTime(2000);
    expect(s.get()).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("drops a stored session that is already over", () => {
    const store = memoryStorage();
    store.setItem("svs_admin_session", JSON.stringify({ token: "old", expires_at: "2020-01-01T00:00:00Z" }));
    expect(new AdminSession(store).get()).toBeNull();
    expect(store.getItem("svs_admin_session")).toBeNull();
  });
});
