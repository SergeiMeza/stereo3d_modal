"use client";

/**
 * Projects A (plans canvas, 2026-11-04): a slim banner above the drop zone
 * for people without a plan — "Pro takes 15% off every video. Monthly also
 * includes 20 free previews a month. See plans ×". Dismissed, it folds to
 * one line ("Save 15–25% on every video with a plan. See plans"); the full
 * banner returns 7 days after the dismissal (kept on the account).
 */

import { X } from "lucide-react";
import Link from "next/link";
import type { JSX } from "react";

import { usePricing } from "@/lib/api/usePricing";

import {
  proPct,
  saveRange,
  useDismissal,
  usePaywallEvents,
  usePlanTier,
  useViewEvent,
} from "./upsell";

export const BANNER_DAYS = 7;

export function PlansBanner(): JSX.Element | null {
  const tier = usePlanTier();
  const pricing = usePricing();
  const { dismissed, dismiss } = useDismissal("projects_banner", BANNER_DAYS);
  const pct = proPct(pricing);
  const range = saveRange(pricing);
  const previews = pricing?.free_previews?.allowances?.pro_monthly;
  const eligible = tier === "none" && dismissed !== null && pct !== null && range !== null;
  const full = eligible && dismissed === false;
  const line = eligible && dismissed === true;
  useViewEvent("projects_banner", tier, full, { variant: "banner" });
  useViewEvent("projects_banner", tier, line, { variant: "line" });
  const send = usePaywallEvents("projects_banner", tier, { variant: full ? "banner" : "line" });
  if (!eligible) return null;

  if (line) {
    return (
      <p data-testid="plans-line" className="text-sm text-fg-muted">
        <span className="hidden sm:inline">Save {range} on every video with a plan.</span>
        <span className="sm:hidden">Save {range} with a plan.</span>{" "}
        <Link href="/plans" onClick={() => send("click", { target: "/plans" })} className="text-primary hover:underline">
          See plans
        </Link>
      </p>
    );
  }
  return (
    <div
      role="note"
      data-testid="plans-banner"
      className="flex items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-2.5 text-sm"
    >
      <p className="flex-1 text-fg">
        Pro takes {pct}% off every video.
        {typeof previews === "number" && previews > 0 ? (
          <span className="hidden sm:inline"> Monthly also includes {previews} free previews a month.</span>
        ) : null}
      </p>
      <Link
        href="/plans"
        onClick={() => send("click", { target: "/plans" })}
        className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/80"
      >
        See plans
      </Link>
      <button
        type="button"
        aria-label="Dismiss"
        data-testid="plans-banner-dismiss"
        onClick={() => {
          send("dismiss");
          dismiss();
        }}
        className="shrink-0 rounded p-0.5 text-fg-muted hover:text-fg"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
