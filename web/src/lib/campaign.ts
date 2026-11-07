/**
 * The launch offer (owner 2026-11-07, gateway 00175): a share off web
 * Lifelike production runs at the qualities /v1/pricing lists, while it's
 * active. Prices stay the list prices; the quote takes the offer off and
 * says so ("Launch offer −25%"). Everything here reads /v1/pricing's
 * campaign and goes quiet on its own when it isn't active. The words are
 * the web's, built from the gateway's fields (pct, ends_at, campaign_pct,
 * campaign_cents); its English label is the fallback only when a field
 * is missing (owner 2026-11-07).
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

/** 0.25 or 25 → 25; null without one */
function asPercent(v: number | null | undefined): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v <= 1 ? v * 100 : v);
}

/** "Launch offer −25%" from the share; the gateway's label (when it has
 * the share in it, from that share) only without one. */
export function offerLabel(pct: number | null | undefined, gatewayLabel: string | null | undefined, t: Tr = EN): string {
  const p = asPercent(pct) ?? asPercent(Number(/(\d+(?:\.\d+)?)\s*%/.exec(gatewayLabel ?? "")?.[1]));
  if (p !== null) return t("offer.label", { pct: String(p) });
  return gatewayLabel ?? t("offer.name");
}

/** "Launch offer until Jan 10": the end in the reader's language, as a
 * Pacific day (the offer ends at the end of Jan 10, Pacific). */
export function offerUntil(endsAt: string | null | undefined, gatewayLabel: string | null | undefined, t: Tr = EN): string {
  const d = endsAt ? new Date(endsAt) : null;
  if (!d || Number.isNaN(d.getTime())) return gatewayLabel ?? t("offer.name");
  const date = d.toLocaleDateString(t.intl, { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
  return t("offer.until", { date });
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

/** "Launch offer until Jan 10: −25% on 1080p and 1440p."; null while
 * none is active. */
export function campaignNote(pricing: PublicPricing | null | undefined, t: Tr = EN): string | null {
  const c = activeCampaign(pricing);
  if (!c) return null;
  const pct = percentOf(c);
  const names = (c.presets ?? []).map((p) => qualityName(p as Preset, t));
  const on =
    names.length > 1
      ? t("offer.note.list", { rest: names.slice(0, -1).join(t("offer.note.listSeparator")), last: names.at(-1) })
      : (names[0] ?? "");
  const label = offerUntil(c.ends_at, c.label, t);
  if (pct && on) return t("offer.note.pctOn", { label, pct: String(pct), on });
  if (pct) return t("offer.note.pctOnly", { label, pct: String(pct) });
  if (on) return t("offer.note.onOnly", { label, on });
  return t("offer.note.labelOnly", { label });
}
