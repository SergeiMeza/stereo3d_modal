"use client";

/**
 * The Plans page's top (plans canvas, 2026-11-04):
 * - Onboarding B: a first-visit hint, "You never have to pick a plan",
 *   with the tier shares from /v1/pricing; Got it is kept on the account
 *   (settings.dismissed plans_hint, so the test reset can bring it back).
 * - Pay per video and Pro beside the Business and Studio cards below, with
 *   the canvas's copy points: "$0 a month" and "Up to 30 fps" (the gateway's
 *   max_fps_without_plan).
 */

import Link from "next/link";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import type { PublicPricing } from "@/lib/api/types";
import { useAuth } from "@/lib/auth";
import { useProPlans } from "@/lib/pro/usePro";

import { proPct, useDismissal, usePaywallEvents, usePlanTier, useViewEvent } from "./upsell";

export function PlansHint({ pricing }: { pricing: PublicPricing }): JSX.Element | null {
  const { user } = useAuth();
  const tier = usePlanTier();
  const { dismissed, dismiss } = useDismissal("plans_hint", null);
  const pct = pricing.tiers?.classic_pct ?? {};
  const show = !!user && dismissed === false;
  useViewEvent("plans_hint", tier, show);
  const send = usePaywallEvents("plans_hint", tier);
  if (!show) return null;
  const shares = (["pro", "business", "studio"] as const)
    .filter((k) => typeof pct[k] === "number")
    .map((k) => `${Math.round(pct[k]! * 100)}% with ${k === "pro" ? "Pro" : k === "business" ? "Business" : "Studio"}`);
  return (
    <div role="note" data-testid="plans-hint" className="mb-6 flex flex-col gap-2 rounded-xl border border-primary/40 bg-primary/5 p-4 text-sm">
      <p className="font-semibold text-fg">You never have to pick a plan</p>
      <p className="text-fg-muted">
        Pay per video is how everyone starts. A plan only lowers the price a minute
        {shares.length > 0 ? `: ${shares.slice(0, -1).join(", ")}${shares.length > 1 ? ", " : ""}${shares.at(-1)}.` : "."}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="w-fit"
        onClick={() => {
          send("dismiss");
          dismiss();
        }}
      >
        Got it
      </Button>
    </div>
  );
}

export function PayPerVideoAndPro({ pricing }: { pricing: PublicPricing }): JSX.Element {
  const tier = usePlanTier();
  const plans = useProPlans();
  const pct = proPct(pricing);
  const monthly = plans.state === "ready" ? plans.plans.find((p) => p.kind === "monthly") : undefined;
  const fps = pricing.fps.max_fps_without_plan ?? 30;
  const previews = pricing.free_previews?.allowances?.pro_monthly;
  return (
    <div className="mb-4 grid gap-4 sm:grid-cols-2">
      <div data-testid="plan-ppv" className="flex flex-col gap-2 rounded-xl border border-edge bg-card p-6">
        <h3 className="text-base font-semibold">Pay per video</h3>
        <p className="text-2xl font-semibold">
          $0 <span className="text-sm font-normal text-fg-muted">a month</span>
        </p>
        <p className="text-sm text-fg-muted">Pay for each video after it&apos;s done. First preview free.</p>
        <p className="text-sm text-fg-muted">Up to {fps} fps</p>
        {tier === "none" ? <p className="mt-auto pt-2 text-xs text-fg-muted">Your plan</p> : null}
      </div>
      <div data-testid="plan-pro" className="flex flex-col gap-2 rounded-xl border border-primary/50 bg-card p-6">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">Pro</h3>
          {pct ? <span className="text-xs text-primary">{pct}% off</span> : null}
        </div>
        <p className="text-2xl font-semibold">
          {monthly ? monthly.price : "…"} <span className="text-sm font-normal text-fg-muted">a month</span>
        </p>
        <p className="text-sm text-fg-muted">
          {typeof previews === "number" && previews > 0 ? `${previews} free previews a month on Monthly. ` : ""}
          Up to {fps} fps
        </p>
        <Button asChild className="mt-auto w-full">
          <Link href="/pro">{tier === "pro" ? "Your plan" : "Get Pro"}</Link>
        </Button>
      </div>
    </div>
  );
}
