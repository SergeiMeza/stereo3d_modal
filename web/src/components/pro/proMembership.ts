/**
 * QA 2026-11-05: what a Pro member's /pro says about their Pro, from
 * GET /v1/pro (and, for web Pro, the plan block on GET /v1/billing): where
 * it comes from, its period, when it renews or ends when that's known,
 * and where to manage it. A source the gateway doesn't name (missing or
 * "unknown") gets a generic line.
 */

import type { AccountPlan } from "@/lib/api/types";
import { EN, type Tr } from "@/lib/i18n/t";
import { isStripePro, proSourceKind, type ProStatus } from "@/lib/pro/usePro";
import { SITE_NAME } from "@/lib/site";

export type ManageAt = "billing" | "apple" | null;

/** "Monthly" from a product or plan id (pro_monthly, pro_subs_1y_v1…). */
export function periodWord(id: string | null | undefined, t: Tr = EN): string | null {
  const s = (id ?? "").toLowerCase();
  if (/(^|_)(1y|12m|yearly|year|annual)(_|$)/.test(s)) return t("pro.plans.name.yearly");
  if (/(^|_)(1m|monthly|month)(_|$)/.test(s)) return t("pro.plans.name.monthly");
  if (/(^|_)(1w|weekly|week)(_|$)/.test(s)) return t("pro.plans.name.weekly");
  return null;
}

function longDate(iso: string | undefined, t: Tr): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(t.locale === "en" ? "en-GB" : t.intl, { day: "numeric", month: "short", year: "numeric" });
}

/** " Renews on 5 Dec 2026." / " Ends on …", or "" when unknown. */
function whenLine(renews: string | null | undefined, ends: string | null | undefined, t: Tr): string {
  const end = longDate(ends ?? undefined, t);
  if (end) return ` ${t("pro.membership.endsOn", { date: end })}`;
  const renew = longDate(renews ?? undefined, t);
  return renew ? ` ${t("pro.membership.renewsOn", { date: renew })}` : "";
}

/** "Pro Monthly", or "Pro" when the period isn't known. */
function proWith(period: string | null, t: Tr): string {
  return period ? t("pro.plans.proName", { name: period }) : "Pro";
}

/** /pro for a member whose Pro we can't place (QA batch 3). */
export const PRO_UNKNOWN_LINE = EN("pro.membership.unknown");

/** The line, and where it's managed; null when there's nothing to say
 * (not Pro, Pro included with Business or Studio, a simulated Pro). From
 * GET /v1/pro's source, period, renews_at/ends_at (QA batch 3), and for
 * web Pro the plan block on GET /v1/billing. */
export function proMembership(
  status: ProStatus | null | undefined,
  plan: AccountPlan | null | undefined,
  t: Tr = EN,
): { text: string; manage: ManageAt } | null {
  const kind = proSourceKind(status);
  if (kind === null || kind === "team" || kind === "simulated") return null;
  const s = status!;
  if (kind === "web" || isStripePro(s, plan)) {
    const billingPlan = plan?.plan === "pro" ? plan : null;
    const period =
      periodWord(billingPlan?.plan_id, t) ?? periodWord(s.period, t) ?? periodWord(s.plan_id ?? s.via, t);
    const when = billingPlan?.current_period_end
      ? whenLine(billingPlan.cancel_at_period_end ? null : billingPlan.current_period_end, billingPlan.cancel_at_period_end ? billingPlan.current_period_end : null, t)
      : whenLine(s.renews_at, s.ends_at, t);
    return { text: `${t("pro.membership.web", { plan: proWith(period, t) })}${when}`, manage: "billing" };
  }
  if (kind === "app_store" || kind === "mac_app_store") {
    const period = periodWord(s.period, t) ?? periodWord(s.via, t);
    const key = kind === "mac_app_store" ? "pro.membership.macAppStore" : "pro.membership.appStore";
    return { text: `${t(key, { plan: proWith(period, t) })}${whenLine(s.renews_at, s.ends_at, t)}`, manage: "apple" };
  }
  if (kind === "grant") {
    return {
      text: `${t("pro.membership.grant", { app: SITE_NAME })}${whenLine(null, s.ends_at, t)}`,
      manage: null,
    };
  }
  return { text: t("pro.membership.unknown"), manage: null };
}
