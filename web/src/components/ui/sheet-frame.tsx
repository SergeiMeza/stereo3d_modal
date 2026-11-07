"use client";

/**
 * The frame every payment sheet sits in (spec v6 G2, "Frames per device"):
 *
 * - Phone (< 600 px): a bottom sheet at full height with a grab handle and
 *   ✕; the main button is pinned above the safe area, the form scrolls
 *   under it.
 * - Desktop and tablet: a centred dialog 440 px wide, at most 90vh, ✕; Esc
 *   closes except while paying.
 * - Headset browsers: a centred panel 560 px, 56 px targets, 20 px text.
 *
 * Motion: slides up in 200 ms; under reduced motion it fades.
 *
 * owner 2026-11-07 (foldable, iPhone Duo): never taller than the screen
 * you can see (sheet-frame-*: svh/dvh less the safe areas). The body and
 * the footer scroll together; the footer is pinned at the bottom, and on
 * very short screens (cramped, ≤ 560 px) only its main button stays
 * pinned (a footer marked data-pin-main: MainButtonArea, the top-up
 * footers) so the form keeps room; other footers stay pinned whole. Nothing has a fixed
 * height: the payment form grows inside the scroll.
 */

import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { JSX, ReactNode } from "react";

import { useT } from "@/lib/i18n/I18nProvider";

import { useClient } from "@/components/steps/ViewIn3D";
import { isHeadset } from "@/lib/headset";

export type SheetFrameKind = "phone" | "desktop" | "headset";

const PHONE_QUERY = "(max-width: 599px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener?.("change", onChange);
  return () => mq.removeEventListener?.("change", onChange);
}

function isPhone(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(PHONE_QUERY).matches;
}

/** Which frame this device gets. */
export function useSheetFrame(): SheetFrameKind {
  const client = useClient();
  const phone = useSyncExternalStore(subscribe, isPhone, () => false);
  if (isHeadset(client)) return "headset";
  return phone ? "phone" : "desktop";
}

const CONTENT: Record<SheetFrameKind, string> = {
  phone:
    "sheet-frame-phone inset-x-0 bottom-0 rounded-t-2xl pt-2 data-open:animate-in data-open:slide-in-from-bottom data-closed:animate-out data-closed:slide-out-to-bottom motion-reduce:data-open:slide-in-from-bottom-0 motion-reduce:data-open:fade-in-0",
  desktop:
    "sheet-frame-centred top-1/2 left-1/2 w-[440px] max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-4 motion-reduce:data-open:slide-in-from-bottom-0",
  headset:
    "sheet-frame-centred top-1/2 left-1/2 w-[560px] max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-3xl text-xl data-open:animate-in data-open:fade-in-0",
};

/**
 * One sheet. `footer` is the main button area: pinned on phones, at the
 * end elsewhere. `locked` (paying) disables Esc, outside clicks and ✕.
 */
export function SheetFrame({
  open,
  onClose,
  locked = false,
  title,
  subtitle,
  media,
  children,
  footer,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  locked?: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  media?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
}): JSX.Element {
  const t = useT();
  const frame = useSheetFrame();
  const big = frame === "headset";
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !locked) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 pointer-fine:backdrop-blur-xs duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          data-testid={testId}
          data-frame={frame}
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => locked && e.preventDefault()}
          onPointerDownOutside={(e) => locked && e.preventDefault()}
          className={`fixed z-50 flex flex-col bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10 duration-200 outline-none ${CONTENT[frame]}`}
        >
          {frame === "phone" ? (
            <span aria-hidden className="mx-auto mb-1 h-1 w-10 shrink-0 rounded-full bg-foreground/20" />
          ) : null}
          <div className={`flex shrink-0 items-start gap-3 ${big ? "px-8 pt-7" : "px-5 pt-4"}`}>
            {media}
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title
                className={`font-semibold tracking-tight tabular-nums ${big ? "text-2xl" : "text-lg"}`}
              >
                {title}
              </DialogPrimitive.Title>
              {subtitle ? (
                <p className={`mt-0.5 line-clamp-2 break-words text-fg-muted ${big ? "text-xl" : "text-xs"}`}>
                  {subtitle}
                </p>
              ) : null}
            </div>
            <DialogPrimitive.Close
              disabled={locked}
              aria-label={t("common.ui.close")}
              className={`-me-1 flex shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-foreground/10 hover:text-fg disabled:opacity-40 ${
                big ? "size-14" : "size-8"
              }`}
            >
              <XIcon className={big ? "size-6" : "size-4"} />
            </DialogPrimitive.Close>
          </div>
          <div
            data-testid="sheet-scroll"
            className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain"
          >
            <div className={`shrink-0 ${big ? "px-8 py-5" : "px-5 py-4"} cramped:py-3`}>{children}</div>
            {footer ? (
              <div
                data-testid="sheet-footer"
                className={`sticky bottom-0 z-10 mt-auto shrink-0 border-t border-edge/60 bg-popover ${big ? "px-8 pt-4 pb-7" : "px-5 pt-3 pb-4"} ${
                  frame === "phone" ? "pb-[max(1rem,env(safe-area-inset-bottom))]" : ""
                } cramped:has-[[data-pin-main]]:contents`}
              >
                {footer}
              </div>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
