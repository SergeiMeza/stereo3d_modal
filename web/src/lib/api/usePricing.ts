"use client";

/**
 * GET /v1/pricing (public), read once per page load and shared: the
 * Pricing page, the upload box's "from $X a minute" and the landing page.
 * null until it arrives or when it fails.
 */

import { useEffect, useState } from "react";

import type { PublicPricing } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

let cached: Promise<PublicPricing | null> | null = null;

/** Test hook: forget the shared answer. */
export function resetPricingCache(): void {
  cached = null;
}

export function usePricing(): PublicPricing | null {
  const gateway = useGateway();
  const [pricing, setPricing] = useState<PublicPricing | null>(null);
  useEffect(() => {
    let cancelled = false;
    cached ??= gateway.getPricing().catch(() => {
      cached = null;
      return null;
    });
    void cached.then((p) => {
      if (!cancelled) setPricing(p);
    });
    return () => {
      cancelled = true;
    };
  }, [gateway]);
  return pricing;
}

/** The lowest per-minute price across both methods. */
export function fromPerMinute(p: PublicPricing): number | null {
  const all = [
    ...Object.values(p.methods.lifelike?.production_cents_per_minute ?? {}),
    ...Object.values(p.methods.classic?.production_cents_per_minute ?? {}),
  ].filter((v): v is number => typeof v === "number" && v > 0);
  return all.length > 0 ? Math.min(...all) : null;
}
