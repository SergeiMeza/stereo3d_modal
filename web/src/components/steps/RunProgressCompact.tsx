"use client";

/**
 * A run in progress in one compact block (owner 2026-11-05): the state
 * chip, the current step ("Making the 3D video · Rendering in 3D"), a thin
 * bar and the time left. The Make 3D tab pins it to the bottom of the
 * screen while the full tracker is below the fold (PinnedRun); the Files
 * tab shows it in a running row. It reads the live run (lib/live), so
 * every place shows the same moment.
 */

import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Progress } from "@/components/ui/progress";
import type { Conversion } from "@/lib/api/types";
import { formatTimeLeft } from "@/lib/format";

import { stageStep, stepLines, TERMINAL_STATES } from "./ConversionTracker";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import { useLiveRun } from "@/lib/live/useLive";
import { runStatus } from "./runStatus";
import { stageLabel } from "./stageLabels";
import { StateChip } from "./StateChip";

/** "Making the 3D video · Rendering in 3D", or the wait in words. */
export function currentStepLine(conv: Conversion, t: Tr = EN): string {
  if (conv.waiting_for_gpu === true || conv.state === "paid" || conv.state === "created") {
    return runStatus(conv, t).label;
  }
  const line = stepLines(t)[stageStep(conv.stage)];
  return conv.stage ? `${line} · ${stageLabel(conv.stage, t)}` : line;
}

export function RunProgressCompact({
  conversion,
  chip = true,
}: {
  conversion: Conversion;
  /** the state chip (a Files row has its own) */
  chip?: boolean;
}): JSX.Element | null {
  // the run as the live feed knows it (owner 2026-11-07), like every
  // other place that shows it
  const t = useT();
  const conv = useLiveRun(conversion);
  const terminal = TERMINAL_STATES.has(conv.state);

  if (terminal) return null;
  const working = conv.state === "processing" && conv.waiting_for_gpu !== true;
  const pct = Math.round(Math.min(Math.max(conv.progress ?? 0, 0), 1) * 100);
  const eta = working && typeof conv.eta_seconds === "number" && conv.eta_seconds > 0 ? conv.eta_seconds : null;
  return (
    <div data-testid="run-compact" className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {chip ? <StateChip conversion={conv} /> : null}
        <span data-testid="run-compact-step" className="min-w-0 truncate text-fg">
          {currentStepLine(conv, t)}
        </span>
        {eta !== null ? (
          <span data-testid="run-compact-eta" className="ms-auto shrink-0 text-fg-muted">
            {formatTimeLeft(eta, t)}
          </span>
        ) : null}
      </div>
      {working ? <Progress value={pct} className="h-1" /> : null}
    </div>
  );
}

/** Height the floating bar may take at the bottom of the screen. */
const BAR_PX = 96;

/**
 * The Make 3D tab's run tracker (owner 2026-11-05: it sat below the fold
 * on an iPad): while its place is below the screen, a compact copy sticks
 * to the bottom (position: sticky in its own place, above the safe area);
 * scrolled to, the full tracker sits inline. It never covers the Make 3D
 * button: while that button is in the bottom band, nothing floats.
 */
export function PinnedRun({ conversion, children }: { conversion: Conversion; children: ReactNode }): JSX.Element {
  const slot = useRef<HTMLDivElement | null>(null);
  const [float, setFloat] = useState(false);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = slot.current;
      if (!el) return;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const below = el.getBoundingClientRect().top > vh - 24;
      const button = el.closest("[data-run-panel]")?.querySelector('[data-testid="checkout-main"]');
      let covers = false;
      if (button) {
        const r = button.getBoundingClientRect();
        covers = r.bottom > vh - BAR_PX && r.top < vh;
      }
      setFloat(below && !covers);
    };
    const later = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", later, { capture: true, passive: true });
    window.addEventListener("resize", later);
    window.visualViewport?.addEventListener("resize", later);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", later, { capture: true });
      window.removeEventListener("resize", later);
      window.visualViewport?.removeEventListener("resize", later);
    };
  }, []);

  return (
    <>
      <div ref={slot} aria-hidden className="h-0" />
      {float ? (
        <div
          data-testid="run-pinned"
          className="sticky bottom-[env(safe-area-inset-bottom)] z-20 rounded-xl border border-edge bg-surface-1 p-3 shadow-lg"
        >
          <RunProgressCompact conversion={conversion} />
        </div>
      ) : null}
      {children}
    </>
  );
}
