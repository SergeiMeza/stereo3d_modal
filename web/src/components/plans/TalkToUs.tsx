"use client";

/**
 * Business nudge C (plans canvas, 2026-11-04): a "Talk to us" banner on
 * Projects, only for company email addresses (not gmail, outlook, icloud,
 * yahoo, qq, 163… — PERSONAL_DOMAINS), and not for Business or Studio.
 * Talk to us opens a small form (message, company, team size) that posts
 * to POST /v1/contact (gateway 00094); a person replies to the account's
 * email. A mailto with the same words only when the route itself fails
 * (network, 404, 5xx); 400 and 429 show the gateway's message. Dismissed
 * for 30 days (kept on the account).
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { formatCentsShort } from "@/components/steps/money";
import { ContactSalesForm } from "./ContactSalesForm";
import { NUDGE_SURFACE, PlanNudge } from "./PlanNudge";
import { companyAtom, loadCompanyAtom } from "@/components/billing/billingHistoryAtoms";
import { prepaidOf } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { usePricing } from "@/lib/api/usePricing";
import { useAuth } from "@/lib/auth";
import { billingUidAtom, useBilling } from "@/lib/billing";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";
import { useT } from "@/lib/i18n/I18nProvider";
import { SITE_NAME } from "@/lib/site";

import {
  isCompanyEmail,
  type SurfaceReason,
  useDismissal,
  usePaywallEvents,
  usePlanTier,
  useViewEvent,
} from "./upsell";

/** A month's spend that looks like Business work (half its usage). */
export const BUSINESS_SIZED_CENTS = 20_000;

/** Whether the account looks like a business (owner 2026-11-05): a
 * company email, business details saved, or Business-sized usage. null
 * while unknown. */
export function useBusinessReason(): SurfaceReason | null {
  const { user } = useAuth();
  const gateway = useGateway();
  const company = useAppAtomValue(companyAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const loadCompany = useAppSetAtom(loadCompanyAtom);
  const status = useBilling().status;
  useEffect(() => {
    if (uid !== null) void loadCompany(gateway);
  }, [loadCompany, gateway, uid]);
  if (isCompanyEmail(user?.email)) return "company_email";
  const details = company.uid === uid ? company.company : null;
  if (details?.company_name?.trim()) return "business_details";
  if ((prepaidOf(status)?.month_spent_cents ?? 0) >= BUSINESS_SIZED_CENTS) return "business_usage";
  return null;
}

/** The one rule for offering Business (owner 2026-11-05): no plan or Pro,
 * and the account looks like a business. Never on Business or Studio.
 * null while unknown. */
export function useBusinessFits(): boolean | null {
  const tier = usePlanTier();
  const reason = useBusinessReason();
  if (tier === null) return null;
  return (tier === "none" || tier === "pro") && reason !== null;
}

/** Where Business may be mentioned in passing (the welcome's last step):
 * when the rule picks it, or with no plan at all. */
export function useBusinessMention(): boolean {
  const tier = usePlanTier();
  const fits = useBusinessFits();
  return tier === "none" || fits === true;
}

/** The Business nudge shows: true, false, or null while unknown. */
export function useBusinessNudgeShown(): boolean | null {
  const biz = usePricing()?.plans?.business;
  const { dismissed } = useDismissal("business_banner", 30);
  const fits = useBusinessFits();
  if (fits === null || dismissed === null) return null;
  return fits && dismissed === false && !!biz;
}

export function TalkToUs(): JSX.Element | null {
  const t = useT();
  const { user } = useAuth();
  const tier = usePlanTier();
  const biz = usePricing()?.plans?.business;
  const { dismiss } = useDismissal("business_banner", 30);
  const [step, setStep] = useState<"banner" | "form" | "sent">("banner");
  const shown = useBusinessNudgeShown() === true;
  const reason = useBusinessReason() ?? "company_email";
  useViewEvent("business_banner", tier, shown, {
    variant: "talk_to_us",
    reason,
  });
  const send = usePaywallEvents("business_banner", tier, {
    variant: "talk_to_us",
    reason,
  });
  // the form and its thanks stay once opened
  if ((!shown && step === "banner") || !biz) return null;

  const onDismiss = () => {
    send("dismiss");
    dismiss();
  };
  if (step === "banner") {
    return (
      <PlanNudge
        testId="talk-to-us"
        text={t("plans.talkToUs.banner", {
          site: SITE_NAME,
          business: "Business",
          amount: formatCentsShort(biz.credit_cents, t),
        })}
        action={{
          label: t("plans.talkToUs.open"),
          testId: "talk-to-us-open",
          onClick: () => {
            send("click", { target: "talk" });
            setStep("form");
          },
        }}
        link={{ label: t("plans.talkToUs.see", { business: "Business" }), href: "/plans", onClick: () => send("click", { target: "/plans" }) }}
        onDismiss={onDismiss}
      />
    );
  }
  return (
    <section data-testid="talk-to-us" className={`flex flex-col gap-3 ${NUDGE_SURFACE}`}>
      {step === "form" ? (
        <ContactSalesForm
          onSent={() => setStep("sent")}
          onCancel={() => setStep("banner")}
          onSend={() => send("click", { target: "send" })}
        />
      ) : (
        <p data-testid="talk-to-us-sent" className="text-fg">
          {t("plans.talkToUs.sent", { email: user?.email ?? t("plans.talkToUs.yourEmail") })}
        </p>
      )}
    </section>
  );
}
