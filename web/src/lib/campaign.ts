/**
 * The launch offer (owner 2026-11-07, gateway 00175): a share off web
 * Lifelike production runs at the qualities /v1/pricing lists, while it's
 * active. Prices stay the list prices; the quote takes the offer off and
 * says so ("Launch offer −25%"). Everything here reads /v1/pricing's
 * campaign and goes quiet on its own when it isn't active. The words are
 * the gateway's (its label carries the end date).
 */

import type { Preset, PublicPricing } from "@/lib/api/types";
import { qualityName } from "@/lib/glossary";

/** The active campaign, or null. */
export function activeCampaign(pricing: PublicPricing | null | undefined) {
  const c = pricing?.campaign;
  if (!c?.active) return null;
  if (c.ends_at && Date.parse(c.ends_at) <= Date.now()) return null;
  return c;
}

/** Does the offer cover this quality right now? */
export function campaignCovers(pricing: PublicPricing | null | undefined, preset: string): boolean {
  return activeCampaign(pricing)?.presets?.includes(preset) === true;
}

function percentOf(c: NonNullable<PublicPricing["campaign"]>): number | null {
  return c.percent ?? (c.pct !== undefined ? Math.round(c.pct * 100) : null);
}

/** "−25% launch offer", for a quality the offer covers; null otherwise. */
export function campaignBadge(pricing: PublicPricing | null | undefined, preset: string): string | null {
  const c = activeCampaign(pricing);
  if (!c || !campaignCovers(pricing, preset)) return null;
  const pct = percentOf(c);
  return pct ? `−${pct}% launch offer` : "Launch offer";
}

/** "Launch offer until Jan 10: −25% on 1080p and 1440p." (the gateway's
 * label, its date as sent); null while none is active. */
export function campaignNote(pricing: PublicPricing | null | undefined): string | null {
  const c = activeCampaign(pricing);
  if (!c) return null;
  const pct = percentOf(c);
  const names = (c.presets ?? []).map((p) => qualityName(p as Preset));
  const on = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  const what = [pct ? `−${pct}%` : null, on ? `on ${on}` : null].filter(Boolean).join(" ");
  return `${c.label ?? "Launch offer"}${what ? `: ${what}` : ""}.`;
}
