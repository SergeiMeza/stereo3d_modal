import Link from "next/link";
import type { JSX } from "react";

import type { PublicPricing } from "@/lib/api/types";

/** "15–30%": what Pro, Business and Studio save, from GET /v1/pricing
 * (owner copy 2026-11; the 2026-11 rates until the gateway answers). */
export function planSaveRange(pricing: PublicPricing | null): string {
  const pcts = Object.values(pricing?.tiers?.classic_pct ?? {}).filter(
    (v): v is number => typeof v === "number" && v > 0,
  );
  const lo = pcts.length > 0 ? Math.round(Math.min(...pcts) * 100) : 15;
  const hi = pcts.length > 0 ? Math.round(Math.max(...pcts) * 100) : 30;
  return lo === hi ? `${lo}%` : `${lo}–${hi}%`;
}

/** "Pay per video. Plans save 15–30%." with Plans linking to /plans. */
export function PayPerVideoLine({ pricing }: { pricing: PublicPricing | null }): JSX.Element {
  return (
    <>
      Pay per video.{" "}
      <Link href="/plans" className="text-primary hover:underline">
        Plans
      </Link>{" "}
      save {planSaveRange(pricing)}.
    </>
  );
}
