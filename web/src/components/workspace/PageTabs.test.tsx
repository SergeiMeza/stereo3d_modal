/**
 * Duo pass (2026-11-07): on folded portrait the six tabs share the row
 * instead of scrolling it ("Fil…" was cut off); a long label wraps to two
 * lines rather than pushing the row wider.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageTabs, tabsFor } from "./PageTabs";

afterEach(cleanup);

describe("the project tab row on narrow screens", () => {
  it("every tab takes an equal share of the row and its label wraps", () => {
    render(<PageTabs tabs={tabsFor("lifelike")} active="overview" onChange={vi.fn()} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(4);
    for (const tab of tabs) {
      expect(tab.className).toMatch(/\bmin-w-0 flex-1 basis-0\b/);
      expect(tab.className).toMatch(/\bsm:flex-none\b/);
      const label = tab.querySelector("span.line-clamp-2") as HTMLElement;
      expect(label).toBeTruthy();
      expect(label.className).toContain("break-words");
      expect(label.className).not.toContain("whitespace-nowrap");
    }
  });
});
