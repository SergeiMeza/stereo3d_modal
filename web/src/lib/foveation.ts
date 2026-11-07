/**
 * Foveated Detail (owner 2026-11-07, gateway 00172): free and always on
 * at the qualities /v1/pricing lists as included (1080p); an add-on with
 * its share elsewhere. It applies only when the output is below the
 * source's own size; the quote and the run say whether it did.
 */

import type { FoveationInfo, PublicPricing } from "@/lib/api/types";

export const FOVEATED_DETAIL = "Foveated Detail";
export const FOVEATED_HINT = "More detail where you look.";

/** The qualities where it's included, from /v1/pricing. */
export function foveationIncludedPresets(pricing: PublicPricing | null | undefined): readonly string[] {
  return (
    pricing?.addons?.foveated?.included_presets ??
    pricing?.methods?.lifelike?.foveation?.included_presets ??
    []
  );
}

/** Is it included (free, always on) at this quality? */
export function foveationIncludedAt(pricing: PublicPricing | null | undefined, preset: string): boolean {
  return foveationIncludedPresets(pricing).includes(preset);
}

/** The quote or run says it was included and applied. */
export function foveationIncludedApplied(f: FoveationInfo | undefined): boolean {
  return f?.applied === true && f.included === true;
}
