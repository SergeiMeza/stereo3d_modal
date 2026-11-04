"use client";

/**
 * First-project tips (owner-approved canvas, 2026-11-04): four short coach
 * marks on the workspace tabs — Overview, Preview, Make 3D, Files — the
 * first time someone opens a project. "Next" walks through them, "Skip
 * tips" or "Got it" ends them; either is saved on the account
 * (onboarding.tips_done), so they never come back on another device.
 *
 * The mark sits beside the tab on the side rail (wider screens) and below
 * it on the phone's top row, with a ring around the tab.
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { useAccountSettings } from "@/lib/useAccountSettings";

export const WORKSPACE_TIPS: readonly { tab: string; title: string; body: string }[] = [
  {
    tab: "overview",
    title: "Everything about your video",
    body: "Length, size, scenes and the price for the whole video. Looking costs nothing.",
  },
  {
    tab: "preview",
    title: "Try a short part first",
    body: "Pick a few seconds and watch them in 3D before you decide. Your first preview is free.",
  },
  {
    tab: "make",
    title: "Choose, then pay",
    body: "Pick where you will watch and the quality. The price updates as you go, and nothing is charged until you press Make 3D.",
  },
  {
    tab: "files",
    title: "Your 3D files",
    body: "Download them, or open this page in your headset’s browser and press play.",
  },
];

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

function rectOf(tab: string): Box | null {
  const el = document.querySelector(`[data-testid="tab-${tab}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function WorkspaceTips(): JSX.Element | null {
  const { settings, update } = useAccountSettings();
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [closed, setClosed] = useState(false);
  const show = !closed && settings !== null && settings.onboarding?.tips_done !== true;
  const tip = WORKSPACE_TIPS[i];

  useEffect(() => {
    if (!show) return;
    const place = () => setBox(rectOf(tip.tab));
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [show, tip.tab]);

  if (!show) return null;

  const end = (): void => {
    setClosed(true);
    update({ onboarding: { tips_done: true } });
  };
  const last = i === WORKSPACE_TIPS.length - 1;
  // beside the rail on wider screens, below the top row on a phone
  const rail = box !== null && typeof window !== "undefined" && window.innerWidth >= 640;
  const style: React.CSSProperties =
    box === null
      ? { left: 16, right: 16, bottom: 88 }
      : rail
        ? { left: box.left + box.width + 12, top: Math.max(12, box.top + box.height / 2 - 60) }
        : {
            left: 12,
            right: 12,
            top: box.top + box.height + 10,
          };

  return (
    <>
      {box ? (
        <span
          aria-hidden
          data-testid="tip-ring"
          className="pointer-events-none fixed z-40 rounded-[10px] border-2 border-primary"
          style={{ top: box.top - 2, left: box.left - 2, width: box.width + 4, height: box.height + 4 }}
        />
      ) : null}
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="tip-title"
        data-testid="workspace-tip"
        className="fixed z-50 flex flex-col gap-2 rounded-xl border border-primary bg-[#15203a] p-4 shadow-[0_20px_50px_rgba(0,0,0,0.55)] sm:w-80"
        style={style}
      >
        <span className="text-[11px] text-fg-muted">
          {i + 1} of {WORKSPACE_TIPS.length}
        </span>
        <h2 id="tip-title" className="text-[15px] font-semibold text-fg">
          {tip.title}
        </h2>
        <p className="text-[13px] leading-snug text-fg-muted">{tip.body}</p>
        <div className="mt-1 flex items-center justify-between">
          <button type="button" onClick={end} className="text-xs text-fg-muted hover:text-fg">
            Skip tips
          </button>
          <Button
            size="sm"
            data-testid="tip-next"
            onClick={() => (last ? end() : setI(i + 1))}
          >
            {last ? "Got it" : "Next"}
          </Button>
        </div>
      </div>
    </>
  );
}
