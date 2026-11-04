"use client";

/**
 * Header B (plans canvas, 2026-11-04): a Plans link, and for people
 * without a plan a "Save 15–25%" chip inside it (one link, no popover).
 * The range comes from /v1/pricing's tier shares. On phones the chip
 * stands alone beside the logo.
 */

import Link from "next/link";
import type { JSX } from "react";

import { usePricing } from "@/lib/api/usePricing";

import {
  saveRange,
  usePaywallEvents,
  usePlanTier,
  useViewEvent,
} from "./upsell";

export function HeaderPlans(): JSX.Element {
  const tier = usePlanTier();
  const range = saveRange(usePricing());
  const chip = tier === "none" && range !== null;
  useViewEvent("header", tier, chip, { variant: "save_chip" });
  const send = usePaywallEvents("header", tier, { variant: "save_chip" });
  return (
    <Link
      href="/plans"
      data-testid="header-plans"
      onClick={() => chip && send("click", { target: "/plans" })}
      className="flex shrink-0 items-center gap-2 text-fg-muted transition-colors hover:text-fg"
    >
      <span className="hidden sm:inline">Plans</span>
      {chip ? (
        <span
          data-testid="header-save-chip"
          className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
        >
          Save {range}
        </span>
      ) : (
        <span className="sm:hidden">Plans</span>
      )}
    </Link>
  );
}
