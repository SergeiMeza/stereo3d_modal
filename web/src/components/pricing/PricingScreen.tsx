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
import type { JSX } from "react";

import { formatCentsShort } from "@/components/steps/money";
import { InfoPopover } from "@/components/ui/info-popover";

import { fpsRule, usePricing } from "@/lib/api/usePricing";
import { useAuth } from "@/lib/auth";
import { PAY_BEFORE, ROUNDED_UP_LINE } from "@/lib/billingCopy";
import { FirstTimeHint } from "@/components/onboarding/FirstTimeHint";

import { Extras, LifelikePrices } from "./PerMinutePrices";
import { PayPerVideoLine } from "./planCopy";
import { PlansSection } from "./PlansSection";

export function PricingScreen(): JSX.Element {
  const pricing = usePricing();
  const { user } = useAuth();
  const pct = pricing ? Math.round(pricing.discount.pct * 100) : null;
  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Prices</h1>
        <p data-testid="pricing-subtitle" className="mt-2 text-fg-muted">
          <PayPerVideoLine pricing={pricing} />
        </p>
      </div>
      <FirstTimeHint id="pricing" className="mx-auto mt-6 max-w-md text-left" />
      {pricing === null ? (
        <p className="mt-10 text-center text-fg-muted">Loading prices…</p>
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
              {PAY_BEFORE}
            </p>
            <InfoPopover label="How pricing works">
              <span>
                <b>Per minute of video at {pricing.fps.base} fps.</b>{" "}
                {fpsRule(pricing)}. {ROUNDED_UP_LINE} Make only part of a
                video and pay only for that part.
              </span>
              <span>
                <b>{pct}% off</b> any run over{" "}
                {formatCentsShort(pricing.discount.threshold_cents)}.{" "}
                {(pricing.preview_minimum_cents ?? pricing.minimum_cents) ===
                pricing.minimum_cents ? (
                  <>
                    <b>Minimum charge {formatCentsShort(pricing.minimum_cents)}</b>{" "}
                    per run.
                  </>
                ) : (
                  <>
                    <b>Minimum charge</b>{" "}
                    {formatCentsShort(pricing.preview_minimum_cents ?? pricing.minimum_cents)}{" "}
                    per preview, {formatCentsShort(pricing.minimum_cents)} for
                    other runs.
                  </>
                )}
              </span>
              {/* TODO(BL-32): when deferred payments return, split this
                  again into "Over {precharge}: charged when it starts…" and
                  "{precharge} or less: charged after it's done. Failed or
                  cancelled runs are not charged." */}
              <span>
                <b>Paid before it starts.</b> Your credit and balance are used
                first. Cancel while it waits in line, or in its first minute,
                for a full refund. Refunded in full if it fails.
              </span>
              <span>US dollars, excluding tax. Every file type is included.</span>
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
          Start a project
        </Link>
      </div>
    </section>
  );
}
