"use client";

/**
 * /pro (S3D-68): Spatial Video Studio Pro, sold on the web. Members save on
 * every 3D video here (the quote's "Pro −20%", S3D-67) and have Pro in the
 * app too: the web and the app share the account. Web Pro is our own
 * Stripe subscription (gateway 00102).
 *
 * A member sees that they're Pro (and, for a web plan, where to manage
 * it); everyone else sees the plans. After a purchase the quotes are asked
 * again (lib/pro notifyProChanged) and ?next= — the project the person came
 * from — is where Continue goes.
 */

import { BadgeCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import type { JSX } from "react";

import { proPercent } from "@/components/pricing/ProOffer";
import { ProPlans } from "@/components/pro/ProPlans";
import { usePricing } from "@/lib/api/usePricing";
import { useBilling } from "@/lib/billing";
import { isWebPro, useProStatus } from "@/lib/pro/usePro";
import { ScheduledChange } from "@/components/billing/PlanChange";
import { isTeamPlan } from "@/lib/api/types";
import { ProBusinessLine } from "@/components/business/BusinessEntry";
import { ProPeriodChange } from "@/components/pro/ProPeriodChange";
import { FirstTimeHint } from "@/components/onboarding/FirstTimeHint";

function safeNext(raw: string | null): string | null {
  return raw !== null && raw.startsWith("/") && !raw.startsWith("//") ? raw : null;
}

/** Spatial Video Studio Pro's discount on web runs, from /v1/pricing
 * (15 until it answers, the 2026-11 Pro tier). */
function usePct(): number {
  const share = usePricing()?.pro_discount?.pct ?? 0;
  return share > 0 ? proPercent(share) : 15;
}

/** "Pro is included in your Business plan" · Billing. */
export function PlanIncludesPro({ planName }: { planName: string }): JSX.Element {
  return (
    <div data-testid="pro-included" className="ll-edge ll-tint flex items-center gap-3 rounded-xl p-5">
      <BadgeCheck className="size-6 shrink-0 text-primary" aria-hidden="true" />
      <p className="flex-1 text-sm text-fg">Pro is included in your {planName} plan.</p>
      <Link href="/account/billing" className="text-sm text-primary hover:underline">
        Billing
      </Link>
    </div>
  );
}

export function ProScreen(): JSX.Element {
  const status = useProStatus();
  const pct = usePct();
  const next = safeNext(useSearchParams().get("next"));
  const [justBought, setJustBought] = useState(false);

  // Business and Studio include Pro (owner, 2026-11): nothing to sell
  const plan = useBilling().status?.plan;
  const included = isTeamPlan(plan)
    ? (plan.name ?? (plan.plan === "studio" ? "Studio" : "Business"))
    : null;
  const isPro = justBought || status?.pro === true;
  // web Pro is managed on Billing; an App Store Pro in the App Store
  const manage =
    isWebPro(status) || plan?.plan === "pro"
      ? "/account/billing"
      : status?.source === "app_store" || status?.source === "mac_app_store"
        ? (status.management_url ?? null)
        : null;

  return (
    <section className="mx-auto w-full max-w-md space-y-8 px-4 py-12">
      <FirstTimeHint id="pro" />
      <header className="space-y-2">
        <span className="ll-eyebrow">Spatial Video Studio Pro</span>
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          {pct}% off every 3D video
        </h1>
        <p className="text-fg-muted">
          Plus Pro in the app on iPhone, iPad, Mac and Vision Pro.
        </p>
      </header>

      {included !== null ? (
        <PlanIncludesPro planName={included} />
      ) : status === null && !justBought ? (
        <div className="h-48 animate-pulse rounded-xl bg-surface-2" aria-busy="true" />
      ) : isPro ? (
        <div data-testid="pro-member" className="ll-edge ll-tint space-y-4 rounded-xl p-5">
          <div className="flex items-center gap-3">
            <BadgeCheck className="size-6 text-primary" aria-hidden="true" />
            <div>
              <p className="font-semibold text-fg">
                {justBought ? "Welcome to Pro" : "You're Pro"}
              </p>
              <p className="text-sm text-fg-muted">
                {pct}% off applies to every quote.
              </p>
            </div>
          </div>
          {/* gateway 00102: a Pro step-down waits for the period's end */}
          {plan?.plan === "pro" ? <ScheduledChange plan={plan} /> : null}
          <ProPeriodChange />
          <div className="flex flex-wrap gap-2">
            <Link
              href={next ?? "/projects"}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
            >
              {next ? "Back to your video" : "Your projects"}
            </Link>
            {manage !== null && (
              <a
                href={manage}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-edge px-4 py-2 text-sm text-fg transition-colors hover:border-primary/60"
              >
                Manage plan
              </a>
            )}
          </div>
        </div>
      ) : (
        <ProPlans onPurchased={() => setJustBought(true)} />
      )}
      {/* owner 2026-11-04: Business and Studio, one line at the bottom */}
      <ProBusinessLine />
    </section>
  );
}
