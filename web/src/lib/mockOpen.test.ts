import { afterEach, describe, expect, it, vi } from "vitest";

import { mockOpen } from "./mockOpen";

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
});

describe("mock deep links (screenshots)", () => {
  it("open a screen from ?mockOpen= only under the mock gateway", () => {
    window.history.replaceState(null, "", "/pricing?mockOpen=business");
    vi.stubEnv("NEXT_PUBLIC_API_MOCK", "");
    expect(mockOpen()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_API_MOCK", "1");
    expect(mockOpen()).toBe("business");
    window.history.replaceState(null, "", "/pricing");
    expect(mockOpen()).toBeNull();
  });
});
