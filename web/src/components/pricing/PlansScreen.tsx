"use client";

import Link from "next/link";
import type { JSX } from "react";

import { usePricing } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";
import { PayPerVideoAndPro, PlansHint } from "@/components/plans/PlansIntro";

import { PlansSection } from "./PlansSection";

/** /plans: the two plan cards and a way back to the per-minute prices. */
export function PlansScreen(): JSX.Element {
  const t = useT();
  const pricing = usePricing();
  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-10">
      {pricing === null ? (
        <p className="mt-10 text-center text-fg-muted">{t("pricing.plansScreen.loading")}</p>
      ) : pricing.plans ? (
        <>
          {/* plans canvas: Onboarding B, then pay per video and Pro */}
          <PlansHint pricing={pricing} />
          <PayPerVideoAndPro pricing={pricing} />
          <PlansSection pricing={pricing} />
        </>
      ) : (
        <p className="mt-10 text-center text-fg-muted">{t("pricing.plansScreen.unavailable")}</p>
      )}
      <p className="mt-8 text-center text-sm">
        <Link href="/pricing" className="text-primary hover:underline">
          {t("pricing.plansScreen.perMinuteLink")}
        </Link>
      </p>
    </section>
  );
}
