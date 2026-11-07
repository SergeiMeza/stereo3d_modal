"use client";

/**
 * First-project tips (owner-approved canvas, 2026-11-04): four short coach
 * marks on the workspace tabs — Overview, Preview, Make 3D, Files — the
 * first time someone opens a project. "Next" walks through them, "Skip
 * tips" or "Got it" ends them; either is saved on the account
 * (onboarding.tips_done), so they never come back on another device.
 *
 * The mark is a shadcn Popover anchored to the tab — beside the side rail
 * on wider screens, below the phone's top row — that flips and shifts to
 * stay inside the screen, with a ring around the tab.
 */

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { useT } from "@/lib/i18n/I18nProvider";
import { useAccountSettings } from "@/lib/useAccountSettings";

/** The tabs, in order; each tip's copy is onboarding.tips.<tab>.title/body. */
export const WORKSPACE_TIPS: readonly { tab: "overview" | "preview" | "make" | "files" }[] = [
  { tab: "overview" },
  { tab: "preview" },
  { tab: "make" },
  { tab: "files" },
];

/** The tab's live box; the bottom middle of the screen while the tab
 * isn't there yet. */
function anchorFor(tab: string): { getBoundingClientRect: () => DOMRect } {
  return {
    getBoundingClientRect: () => {
      const el = document.querySelector(`[data-testid="tab-${tab}"]`);
      if (el) return el.getBoundingClientRect();
      return new DOMRect(window.innerWidth / 2, window.innerHeight - 120, 0, 0);
    },
  };
}

export function WorkspaceTips(): JSX.Element | null {
  const t = useT();
  const { settings, update } = useAccountSettings();
  const [i, setI] = useState(0);
  const [closed, setClosed] = useState(false);
  const [ring, setRing] = useState<DOMRect | null>(null);
  const [wide, setWide] = useState(true);
  const show =
    !closed && settings !== null && settings.onboarding?.tips_done !== true;
  const tip = WORKSPACE_TIPS[i];
  const anchor = useMemo(() => ({ current: anchorFor(tip.tab) }), [tip.tab]);

  // the ring follows the tab (decorative; the tip itself is a Popover)
  useEffect(() => {
    if (!show) return;
    const place = () => {
      const el = document.querySelector(`[data-testid="tab-${tip.tab}"]`);
      setRing(el ? el.getBoundingClientRect() : null);
      setWide(window.innerWidth >= 640);
    };
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

  return (
    <>
      {ring ? (
        <span
          aria-hidden
          data-testid="tip-ring"
          className="pointer-events-none fixed z-40 rounded-[10px] border-2 border-primary"
          style={{
            top: ring.top - 2,
            left: ring.left - 2,
            width: ring.width + 4,
            height: ring.height + 4,
          }}
        />
      ) : null}
      <Popover open modal={false}>
        <PopoverAnchor virtualRef={anchor} />
        <PopoverContent
          data-testid="workspace-tip"
          aria-labelledby="tip-title"
          side={wide ? "right" : "bottom"}
          align={wide ? "center" : "start"}
          sideOffset={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          className="flex flex-col gap-2 rounded-xl border-primary bg-[#15203a] p-4 shadow-[0_20px_50px_rgba(0,0,0,0.55)]"
        >
          <span className="text-[11px] text-fg-muted">
            {t("onboarding.tips.progress", { n: i + 1, total: WORKSPACE_TIPS.length })}
          </span>
          <h2 id="tip-title" className="text-[15px] font-semibold text-fg">
            {t(`onboarding.tips.${tip.tab}.title`)}
          </h2>
          <p className="text-[13px] leading-snug text-fg-muted">{t(`onboarding.tips.${tip.tab}.body`)}</p>
          <div className="mt-1 flex items-center justify-between">
            <button
              type="button"
              onClick={end}
              className="text-xs text-fg-muted hover:text-fg"
            >
              {t("onboarding.tips.skip")}
            </button>
            <Button
              size="sm"
              data-testid="tip-next"
              onClick={() => (last ? end() : setI(i + 1))}
            >
              {last ? t("onboarding.tips.gotIt") : t("onboarding.tips.next")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
