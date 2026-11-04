"use client";

/**
 * GET /v1/pricing (public), read once per page load and shared: the
 * Pricing page, the upload box's "from $X a minute" and the landing page.
 * null until it arrives or when it fails.
 */

import type { PublicPricing } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { sharedFetch } from "@/lib/state/sharedFetch";

// ADR 0138: one shared answer in an app-store atom
const pricing = sharedFetch<PublicPricing>();

/** Test hook: forget the shared answer. */
export function resetPricingCache(): void {
  pricing.reset();
}

export function usePricing(): PublicPricing | null {
  const gateway = useGateway();
  return pricing.use(() => gateway.getPricing());
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

/** A frame rate's price factor under /v1/pricing's fps rule. */
export function fpsFactor(p: PublicPricing, fps: number): number {
  return Math.min(p.fps.max_factor, Math.max(p.fps.min_factor, fps / p.fps.base));
}

/** "30 fps +25% · 60 fps ×2.5 (Business and Studio)" (S3D-15), from /v1/pricing's fps rule. */
export function fpsRule(p: PublicPricing): string {
  const f30 = fpsFactor(p, 30);
  const f60 = fpsFactor(p, 60);
  const pct = Math.round((f30 - 1) * 100);
  const times = Math.round(f60 * 100) / 100;
  // owner 2026-11-04: above 30 fps comes with Business and Studio
  return `30 fps ${pct >= 0 ? "+" : "−"}${Math.abs(pct)}% · 60 fps ×${times} (Business and Studio)`;
}
