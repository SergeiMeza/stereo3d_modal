/**
 * Smoother motion (owner 2026-11-10, LL-18): an add-on on every plan,
 * Lifelike runs and previews only, its share (+10%) from /v1/pricing.
 * Steadier 3D from frame to frame. No plan includes it, and a preview with
 * it is never a free one. Classic is never offered it (the gateway answers
 * 400 when it's sent).
 */

import type { Params, PublicPricing } from "@/lib/api/types";
import { EN, type Tr } from "@/lib/i18n/t";

/** The add-on's name. */
export function stabilizeName(t: Tr = EN): string {
  return t("stabilize.name");
}

/** The one-line explanation beside the toggle. */
export function stabilizeHint(t: Tr = EN): string {
  return t("stabilize.hint");
}

/** /v1/pricing offers it for Lifelike (its share, e.g. 0.1), else null. */
export function stabilizePct(pricing: PublicPricing | null | undefined): number | null {
  const a = pricing?.addons?.stabilize;
  if (!a || a.enabled === false) return null;
  if (a.methods && !a.methods.includes("lifelike")) return null;
  return a.pct;
}

/** "+10%" beside the toggle. */
export function stabilizeShare(pct: number): string {
  return `+${Math.round(pct * 100)}%`;
}

/** A run's words: "Smoother motion", or null for a run without it. */
export function stabilizeRunWords(p: Pick<Params, "stabilize"> | null | undefined, t: Tr = EN): string | null {
  return p?.stabilize === true ? stabilizeName(t) : null;
}
