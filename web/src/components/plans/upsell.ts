"use client";

/**
 * Plans and paywalls, the starting set (owner-approved canvas "Plans and
 * paywalls", 2026-11-04): shared state for every placement.
 *
 * - Who sees what: people without a plan see the upsells; Pro, Business and
 *   Studio see none of them, apart from the Plans link and (Pro only) the
 *   Business nudge.
 * - Dismissals live on the account (settings.dismissed, placement → time),
 *   so they follow the person; a surface with `days` returns that long after
 *   the dismissal (Projects A: 7 days).
 * - Prices: the quote and /v1/pricing tier rates only; nothing hardcoded.
 * - Tracking: POST /v1/events plans_surface_view / _dismiss / _click with
 *   {placement, variant?, plan, quote_cents?, target?}; a 429 is dropped.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type { Probe, PublicPricing, StepQuoteResponse } from "@/lib/api/types";
import { QUALITY_SHORT_SIDE } from "@/lib/glossary";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { useBilling } from "@/lib/billing";
import { useProStatus } from "@/lib/pro/usePro";
import { useAccountSettings } from "@/lib/useAccountSettings";

export type PlanTier = "none" | "pro" | "business" | "studio";

/** The account's plan; null while it loads or signed out. */
export function usePlanTier(): PlanTier | null {
  const { user } = useAuth();
  const status = useBilling().status;
  const pro = useProStatus();
  if (!user) return null;
  const plan = status?.plan;
  if (plan?.active) return plan.plan;
  if (status === null || status === undefined) return null;
  if (pro === null) return null;
  return pro.pro ? "pro" : "none";
}

/** "15–25%": what plans save, from /v1/pricing's tier shares. */
export function saveRange(pricing: PublicPricing | null): string | null {
  const pcts = Object.values(pricing?.tiers?.classic_pct ?? {}).filter(
    (v): v is number => typeof v === "number" && v > 0,
  );
  if (pcts.length === 0) return null;
  const lo = Math.round(Math.min(...pcts) * 100);
  const hi = Math.round(Math.max(...pcts) * 100);
  return lo === hi ? `${lo}%` : `${lo}–${hi}%`;
}

/** Pro's share off (15), from /v1/pricing. */
export function proPct(pricing: PublicPricing | null): number | null {
  const p = pricing?.tiers?.classic_pct?.pro ?? pricing?.pro_discount?.pct;
  return typeof p === "number" && p > 0 ? Math.round(p * 100) : null;
}

/** What this run would cost on a tier. The gateway's alt_prices (00094,
 * Lifelike quotes: exact, the tier's rounding, free previews NOT applied —
 * callers check the quote's own free_previews) win; Classic quotes and
 * older runs have none, so the fallback composes it as the gateway does:
 * the tier's price a minute × the quote's billable minutes × its fps
 * factor, the same add-ons on top, against the bulk discount and the
 * minimum. The fallback is null for previews or when a number is missing. */
export function tierPriceFor(
  result: StepQuoteResponse,
  pricing: PublicPricing | null,
  tier: "pro" | "business" | "studio",
): number | null {
  const alt = result.alt_prices?.[tier];
  if (typeof alt === "number") return alt;
  if (result.step !== "production" || !pricing?.tiers) return null;
  const b = result.quote.breakdown;
  if (!b?.preset) return null;
  const per =
    pricing.tiers.lifelike_cents_per_minute[tier]?.[
      b.preset as keyof (typeof pricing.tiers.lifelike_cents_per_minute)["pro"]
    ];
  if (typeof per !== "number") return null;
  const minutes = b.billable_minutes ?? (b.billable_seconds ?? 0) / 60;
  if (minutes <= 0) return null;
  const base = Math.ceil(minutes * per * (b.fps_factor ?? 1) - 1e-9);
  const included =
    pricing.plans?.[tier as "business" | "studio"]?.express_included === true;
  const addonPct = Object.keys(b.addons ?? {})
    .filter((a) => !(a === "express" && included))
    .reduce(
      (s, a) =>
        s +
        (pricing.addons?.[a as keyof NonNullable<PublicPricing["addons"]>]
          ?.pct ?? 0),
      0,
    );
  let total = base + Math.round(base * addonPct);
  const list = b.subtotal_cents;
  if (
    typeof list === "number" &&
    list > pricing.discount.threshold_cents &&
    pricing.discount.pct > 0
  ) {
    total = Math.min(total, list - Math.round(list * pricing.discount.pct));
  }
  return Math.max(total, pricing.minimum_cents);
}

/** Before any discount: the run at list price. */
export function listTotalOf(result: StepQuoteResponse): number {
  return result.quote.breakdown?.subtotal_cents ?? result.quote.amount_cents;
}

// ---------------------------------------------------------- dismissals

/** The gateway's plans placements (00093): events and dismissals. */
export type Placement =
  | "header"
  | "projects_banner"
  | "quote"
  | "receipt"
  | "plans_sheet"
  | "business_note"
  | "business_banner"
  | "plans_hint";

/** Whether a placement is dismissed now: `at` within `days` (null =
 * for good). */
export function isDismissed(
  at: string | undefined,
  days: number | null,
  now = new Date(),
): boolean {
  if (!at) return false;
  if (days === null) return true;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t < days * 86_400_000;
}

/** A placement's dismissal, saved on the account (settings.dismissed,
 * placement → time). `days` null = for good. `dismissed` is null until the
 * settings load. */
export function useDismissal(
  placement: Placement,
  days: number | null,
): {
  dismissed: boolean | null;
  dismiss: () => void;
} {
  const { settings, update } = useAccountSettings();
  const dismiss = useCallback(() => {
    update({ dismissed: { [placement]: true } });
  }, [update, placement]);
  return {
    dismissed:
      settings === null
        ? null
        : isDismissed(settings.dismissed?.[placement], days),
    dismiss,
  };
}

// ------------------------------------------------------------ tracking

/** Why a Business surface shows (00093 events props.reason). */
export type SurfaceReason =
  "source_8k" | "source_fps" | "quote_size" | "run_length" | "company_email";

export interface SurfaceProps {
  variant?: string;
  reason?: SurfaceReason;
  quote_cents?: number;
  /** an id ("get_pro") or a web path ("/plans"), never a full URL */
  target?: string;
}

/** POST /v1/events plans_surface_view | _dismiss | _click with
 * {placement, variant?, plan, quote_cents?, target?} (gateway 00093). */
export function usePaywallEvents(
  placement: Placement,
  tier: PlanTier | null,
  base: SurfaceProps = {},
) {
  const gateway = useGateway();
  const variant = base.variant;
  const quote = base.quote_cents;
  const reason = base.reason;
  return useCallback(
    (action: "view" | "dismiss" | "click", extra: SurfaceProps = {}) => {
      const props: Record<string, unknown> = { placement };
      if (tier) props.plan = tier;
      const v = extra.variant ?? variant;
      if (v) props.variant = v;
      const q = extra.quote_cents ?? quote;
      if (typeof q === "number") props.quote_cents = Math.round(q);
      const r = extra.reason ?? reason;
      if (r) props.reason = r;
      if (extra.target) props.target = extra.target;
      gateway.logEvent(`plans_surface_${action}`, props);
    },
    [gateway, placement, tier, variant, quote, reason],
  );
}

/** One plans_surface_view when `shown` first turns true. */
export function useViewEvent(
  placement: Placement,
  tier: PlanTier | null,
  shown: boolean,
  base: SurfaceProps = {},
): void {
  const send = usePaywallEvents(placement, tier, base);
  const done = useRef(false);
  useEffect(() => {
    if (!shown || done.current) return;
    done.current = true;
    send("view");
  }, [shown, send]);
}

// ---------------------------------------------------- company domains

/** Personal mail providers: no "Talk to us" banner for these (Nudge C). */
export const PERSONAL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "privaterelay.appleid.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "tutanota.com",
  "tuta.io",
  "fastmail.com",
  "hey.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "t-online.de",
  "mail.com",
  "zoho.com",
  "yandex.ru",
  "yandex.com",
  "mail.ru",
  "rambler.ru",
  "qq.com",
  "foxmail.com",
  "163.com",
  "126.com",
  "yeah.net",
  "sina.com",
  "sina.cn",
  "sohu.com",
  "aliyun.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "kakao.com",
  "docomo.ne.jp",
  "ezweb.ne.jp",
  "softbank.ne.jp",
  "nifty.com",
  "orange.fr",
  "free.fr",
  "laposte.net",
  "libero.it",
  "virgilio.it",
  "btinternet.com",
  "comcast.net",
  "verizon.net",
  "att.net",
];

/** A company address: a domain that isn't a personal mail provider. */
export function isCompanyEmail(email: string | null | undefined): boolean {
  const domain = email?.split("@")[1]?.toLowerCase().trim();
  if (!domain || !domain.includes(".")) return false;
  return !PERSONAL_DOMAINS.some(
    (d) => domain === d || domain.endsWith(`.${d}`),
  );
}

// ------------------------------------------------- high-end sources

/** Owner 2026-11-04: high-end sources are guided (never gated) towards
 * Business and Studio. A source above 30 fps → source_fps (the higher
 * rates come with those plans); else above 4K (short side over 2160, the
 * 5K/6K/8K presets) → source_8k. */
export function sourceReason(
  probe: Pick<Probe, "width" | "height" | "fps"> | undefined,
): "source_8k" | "source_fps" | null {
  if (!probe) return null;
  if (probe.fps > 30.01) return "source_fps";
  if (Math.min(probe.width, probe.height) > QUALITY_SHORT_SIDE["4k"])
    return "source_8k";
  return null;
}

/** "5K" / "6K" / "8K": the largest Cinema size the source fills. */
export function sourceSizeWord(probe: Pick<Probe, "width" | "height">): string {
  const short = Math.min(probe.width, probe.height);
  if (short >= QUALITY_SHORT_SIDE["8k"]) return "8K";
  if (short >= QUALITY_SHORT_SIDE["6k"]) return "6K";
  return "5K";
}

/** "20–25%": what Business and Studio save, from /v1/pricing. */
export function businessSaveRange(
  pricing: PublicPricing | null,
): string | null {
  const pct = pricing?.tiers?.classic_pct ?? {};
  const v = [pct.business, pct.studio].filter(
    (x): x is number => typeof x === "number" && x > 0,
  );
  if (v.length === 0) return null;
  const lo = Math.round(Math.min(...v) * 100);
  const hi = Math.round(Math.max(...v) * 100);
  return lo === hi ? `${lo}%` : `${lo}–${hi}%`;
}

const projectKey = (projectId: string) =>
  `svs-dismissed:business_note:${projectId}`;

const projectListeners = new Set<() => void>();
const projectDismissed = new Set<string>();

function readProject(projectId: string): boolean {
  if (projectDismissed.has(projectId)) return true;
  try {
    return window.localStorage.getItem(projectKey(projectId)) !== null;
  } catch {
    return false;
  }
}

/** The high-end guidance, dismissed once per project; every surface of
 * that project hides together. Kept in this browser until the gateway
 * takes per-project keys (asked 2026-11-04). */
export function useProjectDismissal(projectId: string): {
  dismissed: boolean;
  dismiss: () => void;
} {
  const dismissed = useSyncExternalStore(
    (l) => {
      projectListeners.add(l);
      return () => projectListeners.delete(l);
    },
    () => readProject(projectId),
    () => false,
  );
  const dismiss = useCallback(() => {
    projectDismissed.add(projectId);
    try {
      window.localStorage.setItem(
        projectKey(projectId),
        new Date().toISOString(),
      );
    } catch {
      // storage blocked: hidden for this visit
    }
    for (const l of projectListeners) l();
  }, [projectId]);
  return { dismissed, dismiss };
}

/** The Business and Studio prices of a 5K–8K run, from the quote's
 * alt_prices only (nothing composed); null otherwise. */
export function cinemaTierPrices(
  quote: StepQuoteResponse,
): { business: number; studio: number } | null {
  const preset = quote.params?.preset ?? quote.quote.breakdown?.preset;
  if (preset !== "5k" && preset !== "6k" && preset !== "8k") return null;
  const b = quote.alt_prices?.business;
  const st = quote.alt_prices?.studio;
  return typeof b === "number" && typeof st === "number"
    ? { business: b, studio: st }
    : null;
}
