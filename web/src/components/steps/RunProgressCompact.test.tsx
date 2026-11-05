/**
 * Owner 2026-11-05: a run under the fold pins a compact copy to the bottom
 * (step, bar, time left) and never covers the Make 3D button; scrolled to,
 * only the full tracker shows.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Conversion } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";

import { PinnedRun, currentStepLine } from "./RunProgressCompact";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RUN = {
  conversion_id: "convpinned001",
  state: "processing",
  kind: "video",
  project_id: "p1",
  step: "production",
  method: "lifelike",
  stage: "render",
  progress: 0.4,
  eta_seconds: 360,
  params: { preset: "1080p", formats: ["mvhevc"] },
  quote: { amount_cents: 600, currency: "usd" },
  created_at: "2026-11-05T09:00:00Z",
  updated_at: "2026-11-05T09:00:00Z",
} as unknown as Conversion;

/** Lay the page out: where the tracker's place and the button are. */
function layout(slotTop: number, buttonTop: number): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = this.getAttribute("data-testid") === "checkout-main" ? buttonTop : slotTop;
    return { top, bottom: top + 48, left: 0, right: 390, width: 390, height: 48, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
}

function page() {
  return render(
    <AuthProvider>
      <div data-run-panel>
        <button type="button" data-testid="checkout-main">
          Make 3D
        </button>
        <PinnedRun conversion={RUN}>
          <div data-testid="full-tracker" />
        </PinnedRun>
      </div>
    </AuthProvider>,
  );
}

async function scroll(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  });
}

describe("the pinned run", () => {
  it("floats compact while its place is below the screen, then sits inline", async () => {
    // 390 × 844: the tracker's place far below, the button above the fold
    window.innerHeight = 844;
    layout(1600, 300);
    page();
    await scroll();
    const pinned = screen.getByTestId("run-pinned");
    expect(pinned.className).toContain("sticky");
    expect(pinned.className).toContain("bottom-[env(safe-area-inset-bottom)]");
    expect(screen.getByTestId("run-compact-step").textContent).toBe("Making the 3D video · Rendering in 3D");
    expect(screen.getByTestId("run-compact-eta").textContent).toBe("about 6 min left");
    expect(screen.getByRole("progressbar")).toBeTruthy();
    // scrolled to: only the full tracker
    layout(500, -400);
    await scroll();
    expect(screen.queryByTestId("run-pinned")).toBeNull();
    expect(screen.getByTestId("full-tracker")).toBeTruthy();
  });

  it("never covers the Make 3D button (tablet width too)", async () => {
    window.innerHeight = 1024;
    // the button sits in the bottom band where the bar would float
    layout(1800, 1024 - 60);
    page();
    await scroll();
    expect(screen.queryByTestId("run-pinned")).toBeNull();
    // the button scrolls up out of the band: the bar comes back
    layout(1800, 400);
    await scroll();
    expect(screen.getByTestId("run-pinned")).toBeTruthy();
  });

  it("a waiting run says so instead of a step", () => {
    expect(currentStepLine({ ...RUN, waiting_for_gpu: true } as Conversion)).toBe("Waiting in line");
  });
});
