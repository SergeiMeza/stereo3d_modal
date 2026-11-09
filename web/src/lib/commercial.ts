/**
 * Commercial use (owner 2026-11-09): an add-on on every plan, Lifelike
 * runs and previews only, its share (+50%) from /v1/pricing. The video may
 * be used commercially and has no Spatial Video Studio intro clip.
 * Business and Studio no longer include it; a plan active on 2026-11-09
 * keeps it included, at no charge, until its next renewal (GET /v1/billing
 * plan.commercial_included_until, the quote's commercial_included).
 * Classic is never offered it (the gateway answers 400 when it's sent).
 */

import type { AccountPlan, Params, PublicPricing, QuoteBreakdown } from "@/lib/api/types";
import { EN, type Tr } from "@/lib/i18n/t";

/** The add-on's name. */
export function commercialName(t: Tr = EN): string {
  return t("commercial.name");
}

/** The one-line explanation beside the toggle. */
export function commercialHint(t: Tr = EN): string {
  return t("commercial.hint");
}

/** /v1/pricing offers it for Lifelike (its share, e.g. 0.5), else null. */
export function commercialPct(pricing: PublicPricing | null | undefined): number | null {
  const a = pricing?.addons?.commercial;
  if (!a || a.enabled === false) return null;
  if (a.methods && !a.methods.includes("lifelike")) return null;
  return a.pct;
}

/** When a grandfathered plan stops including it (RFC 3339), while it
 * still does; null otherwise. */
export function commercialIncludedUntil(
  plan: Pick<AccountPlan, "active" | "commercial_included_until"> | null | undefined,
  now: number = Date.now(),
): string | null {
  const until = plan?.commercial_included_until;
  if (!plan?.active || !until) return null;
  const at = Date.parse(until);
  return Number.isNaN(at) || at <= now ? null : until;
}

/** The plan includes it: the billing plan says so, or the last quote did. */
export function commercialIncluded(
  plan: Pick<AccountPlan, "active" | "commercial_included_until"> | null | undefined,
  breakdown: QuoteBreakdown | null | undefined,
): boolean {
  return breakdown?.commercial_included === true || commercialIncludedUntil(plan) !== null;
}

/** "Included with your plan until Jan 10, 2027" (or without the date). */
export function commercialIncludedLine(until: string | null, t: Tr = EN): string {
  if (!until) return t("commercial.includedWithPlan");
  const day = new Date(until).toLocaleDateString(t.intl, { month: "short", day: "numeric", year: "numeric" });
  return t("commercial.includedUntil", { date: day });
}

/** A run's words: "Commercial use", "Commercial use (included)", or null
 * for a run without it. */
export function commercialRunWords(
  p: Pick<Params, "commercial" | "commercial_included"> | null | undefined,
  t: Tr = EN,
): string | null {
  if (p?.commercial !== true && p?.commercial_included !== true) return null;
  return p.commercial_included === true ? t("commercial.runIncluded") : commercialName(t);
}
