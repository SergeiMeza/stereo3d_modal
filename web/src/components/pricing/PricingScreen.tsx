"use client";

/**
 * /pricing — public, concise, reference-only (S3D-18, S3D-45): Lifelike
 * 3D only (S3D-01: new projects are Lifelike), "from $X a minute", one
 * compact table with the size per eye for the qualities the gateway
 * enables, the
 * preview's "from" price, one charging line and a "How pricing works"
 * popover. Every number comes from GET /v1/pricing.
 */

import Link from "next/link";
import type { JSX, ReactNode } from "react";

import { formatCentsShort } from "@/components/steps/money";
import { InfoPopover } from "@/components/ui/info-popover";

import { fpsRule, usePricing } from "@/lib/api/usePricing";
import { useAuth } from "@/lib/auth";
import { FirstTimeHint } from "@/components/onboarding/FirstTimeHint";
import { useT } from "@/lib/i18n/I18nProvider";
import { rich } from "@/lib/i18n/rich";

import { Extras, LifelikePrices } from "./PerMinutePrices";
import { PayPerVideoLine } from "./planCopy";
import { PlansSection } from "./PlansSection";

export function PricingScreen(): JSX.Element {
  const t = useT();
  const pricing = usePricing();
  const { user } = useAuth();
  const b = (c: ReactNode) => <b>{c}</b>;
  const pct = pricing ? Math.round(pricing.discount.pct * 100) : null;
  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t("pricing.screen.title")}</h1>
        <p data-testid="pricing-subtitle" className="mt-2 text-fg-muted">
          <PayPerVideoLine pricing={pricing} />
        </p>
      </div>
      <FirstTimeHint id="pricing" className="mx-auto mt-6 max-w-md text-start" />
      {pricing === null ? (
        <p className="mt-10 text-center text-fg-muted">{t("pricing.screen.loading")}</p>
      ) : (
        <>
          <div className="mx-auto mt-8 max-w-md">
            <LifelikePrices pricing={pricing} />
          </div>
          {pricing.pricing_model === "tiers" ? <Extras pricing={pricing} /> : null}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2 text-center">
            {/* TODO(BL-32): when deferred payments return, bring back
                "{CHARGED_AFTER} Runs over {precharge_threshold_cents} are
                charged when they start and refunded if they fail." */}
            <p data-testid="pricing-charge-line" className="text-fg-muted">
              {t("quote.charge.payBeforePublic")}
            </p>
            <InfoPopover label={t("pricing.screen.howItWorks")}>
              <span>
                {rich(t, "pricing.screen.perMinute", { b }, {
                  fps: pricing.fps.base,
                  fpsRule: fpsRule(pricing, t),
                  roundedUp: t("quote.charge.roundedUp"),
                })}
              </span>
              <span>
                {rich(t, "pricing.screen.discount", { b }, {
                  pct,
                  threshold: formatCentsShort(pricing.discount.threshold_cents, t),
                })}{" "}
                {(pricing.preview_minimum_cents ?? pricing.minimum_cents) ===
                pricing.minimum_cents
                  ? rich(t, "pricing.screen.minimumPerRun", { b }, {
                      min: formatCentsShort(pricing.minimum_cents, t),
                    })
                  : rich(t, "pricing.screen.minimumPerPreview", { b }, {
                      previewMin: formatCentsShort(pricing.preview_minimum_cents ?? pricing.minimum_cents, t),
                      min: formatCentsShort(pricing.minimum_cents, t),
                    })}
              </span>
              {/* TODO(BL-32): when deferred payments return, split this
                  again into "Over {precharge}: charged when it starts…" and
                  "{precharge} or less: charged after it's done. Failed or
                  cancelled runs are not charged." */}
              <span>{rich(t, "pricing.screen.paidBefore", { b })}</span>
              <span>{t("pricing.screen.currencyNoTax")}</span>
            </InfoPopover>
          </div>
        </>
      )}
      {pricing?.plans ? (
        <div className="mt-12">
          <PlansSection pricing={pricing} />
        </div>
      ) : null}
      <div className="mt-8 flex justify-center">
        <Link
          href={user ? "/projects" : "/signin"}
          className="rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground hover:bg-primary/80"
        >
          {t("pricing.screen.startProject")}
        </Link>
      </div>
    </section>
  );
}
