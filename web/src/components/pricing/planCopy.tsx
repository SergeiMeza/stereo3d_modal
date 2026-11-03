import Link from "next/link";
import type { JSX } from "react";

import type { PublicPricing } from "@/lib/api/types";

/** "15–25%": what Pro, Business and Studio save, from GET /v1/pricing
 * (owner copy 2026-11); null until it answers, so no number is guessed. */
export function planSaveRange(pricing: PublicPricing | null): string | null {
  const pcts = Object.values(pricing?.tiers?.classic_pct ?? {}).filter(
    (v): v is number => typeof v === "number" && v > 0,
  );
  if (pcts.length === 0) return null;
  const lo = Math.round(Math.min(...pcts) * 100);
  const hi = Math.round(Math.max(...pcts) * 100);
  return lo === hi ? `${lo}%` : `${lo}–${hi}%`;
}

/** "Pay per video. Plans save 15–25%." with Plans linking to /plans;
 * "Pay per video, or save with a plan." until /v1/pricing answers. */
export function PayPerVideoLine({ pricing }: { pricing: PublicPricing | null }): JSX.Element {
  const range = planSaveRange(pricing);
  const plans = (
    <Link href="/plans" className="text-primary hover:underline">
      {range ? "Plans" : "plan"}
    </Link>
  );
  return range ? (
    <>
      Pay per video. {plans} save {range}.
    </>
  ) : (
    <>Pay per video, or save with a {plans}.</>
  );
}
