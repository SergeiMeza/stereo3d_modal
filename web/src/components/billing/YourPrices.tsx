"use client";

/**
 * Plan & billing → "Your prices per minute" (owner 2026-11-07): the same
 * table as /pricing (PerMinutePrices), for the account's plan, and beside
 * it the next plan up with an upgrade button that opens that plan's
 * existing checkout. The ladder is the price order GET /v1/pricing sends
 * (tiers.order: pay per video → Pro → Business → Studio); Studio has no
 * next. A plan that runs to its end (restored or moved, renewable: false)
 * gets no upgrade button: its changes are refused (not_renewable).
 */

import { Collapsible } from "radix-ui";
import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { JSX } from "react";

import { SETUP_PATH } from "@/components/business/BusinessEntry";
import { proCase } from "@/components/business/BusinessSetup";
import { PlanChangeSheet } from "@/components/pay/PlanChangeSheet";
import { PlanSheet } from "@/components/pay/PlanSheet";
import { usePlanTier } from "@/components/plans/upsell";
import { periodWord } from "@/components/pro/proMembership";
import { LifelikePrices, type PriceKey } from "@/components/pricing/PerMinutePrices";
import { Button } from "@/components/ui/button";
import { isTeamPlan } from "@/lib/api/types";
import { usePricing } from "@/lib/api/usePricing";
import { useBilling } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Tr } from "@/lib/i18n/t";
import { isStripePro, useBuyPro, useProOffer, useProStatus } from "@/lib/pro/usePro";
import { useAppAtom } from "@/lib/state/stores";

import { yourPricesOpenAtom } from "./yourPricesAtoms";

const NAMES: Record<Exclude<PriceKey, "list">, string> = { pro: "Pro", business: "Business", studio: "Studio" };
/** A price row's name: the plan's (a product name), or "Pay per video". */
function nameOf(k: PriceKey, t: Tr): string {
  return k === "list" ? t("billing.yourPrices.payPerVideo") : NAMES[k];
}
const LADDER: PriceKey[] = ["studio", "business", "pro", "list"];

/** The plan above `mine` in the server's price order (highest first). */
export function nextPlanUp(mine: PriceKey, order: string[] | undefined): PriceKey | null {
  const ladder = (order?.filter((k): k is PriceKey => LADDER.includes(k as PriceKey)) ?? []).length
    ? order!.filter((k): k is PriceKey => LADDER.includes(k as PriceKey))
    : LADDER;
  const i = ladder.indexOf(mine);
  return i > 0 ? ladder[i - 1] : null;
}

export function YourPrices(): JSX.Element | null {
  const t = useT();
  const pricing = usePricing();
  const tier = usePlanTier();
  const billing = useBilling();
  const pro = useProStatus();
  const [open, setOpen] = useAppAtom(yourPricesOpenAtom);
  if (!pricing || tier === null || !pricing.tiers?.lifelike_cents_per_minute) return null;
  const mine: PriceKey = tier === "none" ? "list" : tier;
  const next = nextPlanUp(mine, pricing.tiers.order);
  const pct = (k: PriceKey) => {
    const v = k === "list" ? undefined : pricing.tiers?.classic_pct?.[k];
    return typeof v === "number" && v > 0 ? Math.round(v * 100) : null;
  };
  const caption = (k: PriceKey) =>
    pct(k) ? t("billing.yourPrices.withPlanOff", { plan: nameOf(k, t), pct: pct(k) }) : nameOf(k, t);
  const plan = billing.status?.plan;
  // gateway 00155: a restored or moved plan runs to its end, no changes
  const endsOnly = plan?.active === true && (plan.renewable === false || !!plan.restored_from);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} asChild>
      <section data-testid="your-prices" aria-labelledby="your-prices-title" className="flex flex-col gap-3">
        <Collapsible.Trigger asChild>
          <button type="button" className="flex items-center gap-2 self-start text-sm font-semibold text-fg">
            <span id="your-prices-title">{t("billing.yourPrices.title")}</span>
            <ChevronDownIcon aria-hidden className={`size-4 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content className="grid gap-4 md:grid-cols-2">
          <LifelikePrices
            pricing={pricing}
            plan={mine}
            title={t("billing.yourPrices.yourPrices")}
            caption={caption(mine)}
            testId="your-prices-mine"
          />
          {next ? (
            <LifelikePrices
              pricing={pricing}
              plan={next}
              title={t("billing.yourPrices.withPlan", { plan: nameOf(next, t) })}
              caption={pct(next) ? t("billing.yourPrices.pctOff", { pct: pct(next) }) : undefined}
              testId="your-prices-next"
              compact
            >
              {endsOnly ? null : <UpgradeButton to={next} webPro={isStripePro(pro, plan)} appStorePro={proCase(pro) === "app_store"} teamName={isTeamPlan(plan) ? (plan.name ?? nameOf(plan.plan as PriceKey, t)) : null} />}
            </LifelikePrices>
          ) : null}
        </Collapsible.Content>
      </section>
    </Collapsible.Root>
  );
}

/** The next plan's existing checkout: Pro's sheet, a new plan's sheet, or
 * a plan change (credited for the unused plan), as /plans opens them. An
 * App Store Pro goes to Business through the Business setup, like the
 * Account entry. */
function UpgradeButton({
  to,
  webPro,
  appStorePro,
  teamName,
}: {
  to: PriceKey;
  webPro: boolean;
  appStorePro: boolean;
  teamName: string | null;
}): JSX.Element | null {
  const pricing = usePricing();
  const offer = useProOffer();
  const buy = useBuyPro();
  const pro = useProStatus();
  const billingPlan = useBilling().status?.plan;
  const t = useT();
  const [sheet, setSheet] = useState<"new" | "change" | null>(null);
  const label = t("billing.yourPrices.upgradeTo", { plan: nameOf(to, t) });

  if (to === "pro") {
    if (!offer) return null;
    return (
      <Button data-testid="upgrade" className="w-full" onClick={() => void buy(offer.plan).catch(() => undefined)}>
        {label}
      </Button>
    );
  }
  if (to === "list") return null;
  const def = pricing?.plans?.[to];
  if (!def) return null;
  if (to === "business" && appStorePro && !webPro) {
    return (
      <Button asChild data-testid="upgrade" className="w-full">
        <Link href={SETUP_PATH}>{label}</Link>
      </Button>
    );
  }
  const change = teamName !== null || webPro;
  // as /plans names it: "Pro Monthly"
  const period = periodWord(billingPlan?.plan === "pro" ? billingPlan.plan_id : (pro?.plan_id ?? pro?.via));
  const from = teamName ?? (webPro ? `Pro${period ? ` ${period}` : ""}` : null);
  return (
    <>
      <Button data-testid="upgrade" className="w-full" onClick={() => setSheet(change ? "change" : "new")}>
        {label}
      </Button>
      {sheet === "change" ? (
        <PlanChangeSheet
          plan={to}
          def={def}
          from={from ?? ""}
          handoverCreditCents={teamName !== null ? def.credit_cents : null}
          onClose={() => setSheet(null)}
        />
      ) : sheet === "new" ? (
        <PlanSheet plan={to} def={def} companyLink onClose={() => setSheet(null)} />
      ) : null}
    </>
  );
}
