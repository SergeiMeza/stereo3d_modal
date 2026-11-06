"use client";

/**
 * Projects A (plans canvas, 2026-11-04): a slim banner above the drop zone
 * for people without a plan — "Pro takes 15% off every video (and, with
 * the gateway's pro_credit, includes $20 credit to start). Monthly also
 * includes 20 free previews a month. See plans ×". Dismissed, it folds to
 * one line ("Save 15–25% on every video with a plan. See plans"); the full
 * banner returns 7 days after the dismissal (kept on the account).
 */

import { creditShort, proCreditCents } from "@/lib/pro/plans";
import Link from "next/link";
import type { JSX } from "react";

import { usePricing } from "@/lib/api/usePricing";

import { PlanNudge } from "./PlanNudge";

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
  const credit = creditShort(proCreditCents(pricing));
  const eligible =
    tier === "none" && dismissed !== null && pct !== null && range !== null;
  const full = eligible && dismissed === false;
  const line = eligible && dismissed === true;
  useViewEvent("projects_banner", tier, full, { variant: "banner" });
  useViewEvent("projects_banner", tier, line, { variant: "line" });
  const send = usePaywallEvents("projects_banner", tier, {
    variant: full ? "banner" : "line",
  });
  if (!eligible) return null;

  if (line) {
    return (
      <p data-testid="plans-line" className="text-sm text-fg-muted">
        <span className="hidden sm:inline">
          Save {range} on every video with a plan.
        </span>
        <span className="sm:hidden">Save {range} with a plan.</span>{" "}
        <Link
          href="/plans"
          onClick={() => send("click", { target: "/plans" })}
          className="text-primary hover:underline"
        >
          See plans
        </Link>
      </p>
    );
  }
  return (
    <PlanNudge
      testId="plans-banner"
      text={
        <>
          Pro takes {pct}% off every video
          {credit ? ` and includes ${credit}` : ""}.
          {typeof previews === "number" && previews > 0 ? (
            <span className="hidden sm:inline"> Monthly also includes {previews} free previews a month.</span>
          ) : null}
        </>
      }
      action={{ label: "See plans", href: "/plans", onClick: () => send("click", { target: "/plans" }) }}
      onDismiss={() => {
        send("dismiss");
        dismiss();
      }}
    />
  );
}
