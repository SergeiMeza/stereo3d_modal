"use client";

/**
 * Business and Studio plans (pricing 2026-11, BL-19): a monthly fee with
 * that much usage included at the plan's own prices, free previews and
 * Express. Every number comes from GET /v1/pricing; Choose opens our
 * payment sheet (PlanSheet).
 *
 * BUX-11 (owner 2026-11-07): Business carries "Recommended", and Studio
 * leads with what it comes to a month, billed yearly.
 */

import { CheckIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { JSX } from "react";

import { PlanChangeSheet } from "@/components/pay/PlanChangeSheet";
import { PlanSheet } from "@/components/pay/PlanSheet";
import { periodWord } from "@/components/pro/proMembership";
import { formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { PlanDef, PublicPricing } from "@/lib/api/types";
import { useAuth } from "@/lib/auth";
import { useBilling } from "@/lib/billing";
import { isTeamPlan } from "@/lib/api/types";
import { isStripePro, useProStatus } from "@/lib/pro/usePro";
import { useT } from "@/lib/i18n/I18nProvider";
import { mockOpen } from "@/lib/mockOpen";
import { EN, type Tr } from "@/lib/i18n/t";

import { planPrice } from "./planCopy";
import { qualitySteps } from "@/components/steps/FileQuality";

const PLAN_KEYS = ["business", "studio"] as const;
type PlanKey = (typeof PLAN_KEYS)[number];

/** BUX-25 (proposal, off by default): Business billed yearly, offered
 * beside monthly while /v1/pricing business_yearly is on and sends the
 * plan. A first purchase only; a plan change stays monthly. */
export function businessYearlyDef(pricing: PublicPricing): PlanDef | null {
  const def = pricing.business_yearly === true ? pricing.plans?.business_yearly : undefined;
  return def && def.interval === "year" ? def : null;
}

/** "Save 17%": a yearly plan against twelve of its months (null under 1%). */
export function yearlySavePct(yearly: PlanDef, monthly: PlanDef): number | null {
  const year = planPrice(yearly).cents;
  const twelve = planPrice(monthly).cents * 12;
  if (twelve <= 0 || year >= twelve) return null;
  const pct = Math.round((1 - year / twelve) * 100);
  return pct >= 1 ? pct : null;
}

/** BUX-11 (owner 2026-11-07): the plan the page recommends. */
export const RECOMMENDED_PLAN: PlanKey = "business";

/** BUX-11: a yearly plan's headline is what it comes to a month, with the
 * yearly charge beside it ("$999 a month", "billed yearly ($11,988)");
 * a monthly plan shows its price. */
export function planHeadline(
  def: PlanDef,
  t: Tr = EN,
): { cents: number; per: string; billedYearly: string | null } {
  const price = planPrice(def, t);
  if (!price.yearly) return { cents: price.cents, per: price.per, billedYearly: null };
  return {
    cents: Math.round(price.cents / 12),
    per: t("pricing.per.month"),
    billedYearly: t("pricing.plans.billedYearly", { amount: formatCentsShort(price.cents, t) }),
  };
}

/** The few lines a plan card shows. */
/** Owner 2026-11-07: Business and Studio name the File quality steps for
 * client work. */
export const PLAN_FILE_QUALITY = planFileQuality();

/** PLAN_FILE_QUALITY in a language. */
export function planFileQuality(t: Tr = EN): string {
  return t("pricing.plans.lines.fileQuality", { high: "High", master: "Master" });
}

export function planLines(
  def: PlanDef,
  pct: number | undefined,
  maxFpsWithPlan?: number,
  fileQuality = false,
  t: Tr = EN,
): string[] {
  // the plan's own max_fps, else /v1/pricing fps.max_fps_with_plan (test
  // gateway 00091 sends only the latter)
  const maxFps = def.max_fps ?? maxFpsWithPlan;
  return [
    t("pricing.plans.lines.usage", { amount: formatCentsShort(def.credit_cents, t) }),
    ...(pct ? [t("pricing.plans.lines.off", { pct: Math.round(pct * 100) })] : []),
    // owner 2026-11-04: Terms "Using your 3D outputs"
    t("pricing.plans.lines.commercial"),
    t("pricing.plans.lines.freePreviews", { count: def.free_previews_per_period }),
    ...(def.express_included ? [t("pricing.plans.lines.express")] : []),
    ...(fileQuality ? [planFileQuality(t)] : []),
    // owner 2026-11-04: above 30 fps comes with a plan
    ...(maxFps && maxFps > 30 ? [t("pricing.plans.lines.fps", { fps: maxFps })] : []),
    // owner 2026-11-04: no seat counts until team accounts exist
    t("pricing.plans.lines.invoices"),
  ];
}

export function PlansSection({ pricing }: { pricing: PublicPricing }): JSX.Element | null {
  const t = useT();
  const { user } = useAuth();
  const billing = useBilling();
  // the sheet is picked when it opens and kept: a purchase that makes the
  // plan active must not swap the open sheet for another
  const [open, setOpen] = useState<{
    plan: PlanKey | "business_yearly";
    from: string | null;
    change: boolean;
    team: boolean;
  } | null>(() => {
    // the mock's screenshot deep link (?mockOpen=business|studio|business_yearly)
    const asked = mockOpen();
    return asked === "business" || asked === "studio" || asked === "business_yearly"
      ? { plan: asked, from: null, change: false, team: false }
      : null;
  });
  // BUX-25: Business monthly or yearly (monthly first, as today)
  const [bizYearly, setBizYearly] = useState(false);
  const pro = useProStatus();
  const plans = pricing.plans;
  if (!plans || PLAN_KEYS.every((k) => !plans[k])) return null;
  // a web Pro's plan block isn't a team plan: Business and Studio stay open
  const teamPlan = billing.status?.plan;
  const mine = isTeamPlan(teamPlan) ? teamPlan.plan : null;
  // coordinator 2026-11-05: for a web Pro they're a plan change (credited
  // for the unused Pro), never a second checkout
  // QA batch 3: only a Pro on our own Stripe plan moves by plan change
  const webPro = isStripePro(pro, billing.status?.plan);
  // owner bug 2026-11-05: on Business, Studio is a plan change (a step-up
  // now, credited for the unused Business), and Studio → Business waits
  // for the paid year's end; never a dead button
  const mineName = mine ? (teamPlan?.name ?? plans[mine]?.name ?? (mine === "studio" ? "Studio" : "Business")) : null;
  const proPeriod = periodWord(billing.status?.plan?.plan === "pro" ? billing.status.plan.plan_id : pro?.plan_id ?? pro?.via);
  const proName = `Pro${proPeriod ? ` ${proPeriod}` : ""}`;
  const yearlyBiz = businessYearlyDef(pricing);
  // a plan change (Business, Studio or a web Pro) stays monthly
  const offerYearly = yearlyBiz !== null && !!plans.business && !mineName && !webPro;
  return (
    <section data-testid="plans" aria-labelledby="plans-title" className="flex flex-col gap-4">
      <div className="text-center">
        <h2 id="plans-title" className="text-lg font-semibold tracking-tight">
          {t("pricing.plans.title")}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          {t("pricing.plans.subtitle", { business: "Business", studio: "Studio" })}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {PLAN_KEYS.map((k) => {
          const def = plans[k];
          if (!def) return null;
          const pct = pricing.tiers?.classic_pct?.[k];
          const recommended = k === RECOMMENDED_PLAN;
          const yearlyHere = k === "business" && offerYearly && bizYearly && yearlyBiz !== null;
          const head = planHeadline(yearlyHere ? yearlyBiz : def, t);
          const save = k === "business" && offerYearly && yearlyBiz ? yearlySavePct(yearlyBiz, def) : null;
          return (
            <div
              key={k}
              data-testid={`plan-${k}`}
              className={`relative flex flex-col gap-4 rounded-xl border bg-card p-6 ${
                recommended ? "border-primary/50" : "border-edge"
              }`}
            >
              {recommended ? (
                <span data-testid={`plan-recommended-${k}`} className="ll-tag-new absolute -top-2.5 start-6">
                  {t("pricing.plans.recommended")}
                </span>
              ) : null}
              <div>
                <h3 className="text-base font-semibold">{def.name}</h3>
                {k === "business" && offerYearly ? (
                  <div
                    role="radiogroup"
                    aria-label={t("pricing.plans.billingPeriod")}
                    data-testid="business-period"
                    className="mt-2 inline-flex rounded-lg border border-edge p-0.5 text-xs"
                  >
                    {([false, true] as const).map((y) => (
                      <button
                        key={String(y)}
                        type="button"
                        role="radio"
                        aria-checked={bizYearly === y}
                        data-testid={y ? "business-yearly" : "business-monthly"}
                        onClick={() => setBizYearly(y)}
                        className={`rounded-md px-2.5 py-1 ${bizYearly === y ? "bg-primary text-primary-foreground" : "text-fg-muted hover:text-fg"}`}
                      >
                        {y ? t("pricing.plans.yearly") : t("pricing.plans.monthly")}
                        {y && save ? ` · ${t("pricing.plans.savePct", { pct: save })}` : ""}
                      </button>
                    ))}
                  </div>
                ) : null}
                <p data-testid={`plan-price-${k}`} className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatCentsShort(head.cents, t)}
                  <span className="text-sm font-normal text-fg-muted"> {head.per}</span>
                </p>
                {head.billedYearly ? (
                  <p data-testid={`plan-billed-${k}`} className="mt-1 text-xs text-fg-muted tabular-nums">
                    {head.billedYearly}
                  </p>
                ) : null}
              </div>
              <ul className="flex flex-col gap-2 text-sm">
                {planLines(def, pct, pricing.fps.max_fps_with_plan, qualitySteps(pricing).length > 2, t).map((l) => (
                  <li key={l} className="flex items-center gap-2">
                    <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />
                    {l}
                  </li>
                ))}
              </ul>
              {mine === k ? (
                <Button variant="outline" disabled className="mt-auto w-full">
                  {t("pricing.plans.yourPlan")}
                </Button>
              ) : user ? (
                <Button
                  data-testid={`choose-${k}`}
                  variant={recommended ? "default" : "outline"}
                  className="mt-auto w-full"
                  onClick={() =>
                    setOpen({
                      plan: yearlyHere ? "business_yearly" : k,
                      from: mineName ?? (webPro ? proName : null),
                      change: mineName !== null || webPro,
                      team: mineName !== null,
                    })
                  }
                >
                  {mine ? t("pricing.plans.changeTo", { name: def.name }) : t("pricing.plans.choose", { name: def.name })}
                </Button>
              ) : (
                <Button asChild variant={recommended ? "default" : "outline"} className="mt-auto w-full">
                  <Link href="/signin?next=/pricing">{t("pricing.plans.choose", { name: def.name })}</Link>
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {open && plans[open.plan] ? (
        open.change && open.plan !== "business_yearly" ? (
          <PlanChangeSheet
            plan={open.plan}
            def={plans[open.plan]!}
            from={open.from ?? ""}
            handoverCreditCents={open.team ? plans[open.plan]!.credit_cents : null}
            onClose={() => setOpen(null)}
          />
        ) : (
          <PlanSheet plan={open.plan} def={plans[open.plan]!} companyLink onClose={() => setOpen(null)} />
        )
      ) : null}
    </section>
  );
}
