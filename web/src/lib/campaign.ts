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
import { EN, type Tr } from "@/lib/i18n/t";

/** The active campaign, or null. */
export function activeCampaign(pricing: PublicPricing | null | undefined) {
  const c = pricing?.campaign;
  if (!c?.active) return null;
  if (c.ends_at && Date.parse(c.ends_at) <= Date.now()) return null;
  return c;
}

/** Does the offer cover this quality (and method) right now? Without a
 * methods list it is Lifelike's (gateway 00175); Classic 3D gets the
 * badge once the gateway lists it. A Classic quote's line shows whenever
 * the quote carries campaign_cents, whatever this says. */
export function campaignCovers(
  pricing: PublicPricing | null | undefined,
  preset: string,
  method: "lifelike" | "classic" = "lifelike",
): boolean {
  const c = activeCampaign(pricing);
  if (!c?.presets?.includes(preset)) return false;
  return c.methods ? c.methods.includes(method) : method === "lifelike";
}

function percentOf(c: NonNullable<PublicPricing["campaign"]>): number | null {
  return c.percent ?? (c.pct !== undefined ? Math.round(c.pct * 100) : null);
}

/** "−25% launch offer", for a quality the offer covers; null otherwise. */
export function campaignBadge(
  pricing: PublicPricing | null | undefined,
  preset: string,
  method: "lifelike" | "classic" = "lifelike",
  t: Tr = EN,
): string | null {
  const c = activeCampaign(pricing);
  if (!c || !campaignCovers(pricing, preset, method)) return null;
  const pct = percentOf(c);
  return pct ? t("offer.badge", { pct: String(pct) }) : t("offer.name");
}

/** "Launch offer until Jan 10: −25% on 1080p and 1440p." (the gateway's
 * label, its date as sent); null while none is active. */
export function campaignNote(pricing: PublicPricing | null | undefined, t: Tr = EN): string | null {
  const c = activeCampaign(pricing);
  if (!c) return null;
  const pct = percentOf(c);
  const names = (c.presets ?? []).map((p) => qualityName(p as Preset, t));
  const on =
    names.length > 1
      ? t("offer.note.list", { rest: names.slice(0, -1).join(t("offer.note.listSeparator")), last: names.at(-1) })
      : (names[0] ?? "");
  const label = c.label ?? t("offer.name");
  if (pct && on) return t("offer.note.pctOn", { label, pct: String(pct), on });
  if (pct) return t("offer.note.pctOnly", { label, pct: String(pct) });
  if (on) return t("offer.note.onOnly", { label, on });
  return t("offer.note.labelOnly", { label });
}
