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

/** Lifelike's lowest per-minute price ("from $3.82 a minute", S3D-11),
 * over the qualities the gateway enables. */
export function fromPerMinute(p: PublicPricing): number | null {
  const m = p.methods.lifelike;
  if (!m) return null;
  const all = m.presets
    .map((q) => m.production_cents_per_minute[q])
    .filter((v): v is number => typeof v === "number" && v > 0);
  return all.length > 0 ? Math.min(...all) : null;
}
