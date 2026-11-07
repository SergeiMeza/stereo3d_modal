"use client";

/**
 * Payments in mainland China are coming soon (owner 2026-11-07). While
 * GET /v1/pricing says china_payments false (missing: false), China mode
 * shows "Payments in mainland China are coming soon." where it would
 * pay: the run's pay sheet, the top-up, a plan or Pro checkout and the
 * hand-off page's Alipay and WeChat Pay. A gateway that still answers 403
 * china_payments_unavailable gets the same line. Browsing, sign-up, the
 * sample and free previews are unchanged.
 */

import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { GatewayError } from "@/lib/api/client";
import { usePricing } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";
import { chinaPayments } from "@/lib/paymentRegion";

import { StateLine } from "./PaySheet";
import { SheetFrame } from "./SheetFrame";

export const CHINA_PAYMENTS_UNAVAILABLE = "china_payments_unavailable";
export const CHINA_COMING_SOON_KEY = "pay.china.comingSoon";

/** The gateway refused a China-mode payment while they're off. */
export function isChinaPaymentsUnavailable(e: unknown): boolean {
  return e instanceof GatewayError && e.code === CHINA_PAYMENTS_UNAVAILABLE;
}

/** Whether China payments are on (/v1/pricing china_payments; missing or
 * not read yet: off). */
export function useChinaPaymentsOn(): boolean {
  return usePricing()?.china_payments === true;
}

/** China mode with its payments still off. */
export function useChinaPaymentsOff(): boolean {
  const on = useChinaPaymentsOn();
  return chinaPayments() && !on;
}

/** The line, where a pay button or a payment form would be. */
export function ChinaComingSoon(): JSX.Element {
  const t = useT();
  return <StateLine testId="china-coming-soon" text={t(CHINA_COMING_SOON_KEY)} />;
}

/** A pay sheet that only says it's coming soon. */
export function ChinaComingSoonSheet({
  title,
  testId,
  onClose,
}: {
  title: string;
  testId: string;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  return (
    <SheetFrame
      open
      onClose={onClose}
      testId={testId}
      title={title}
      footer={
        <Button size="lg" variant="outline" className="h-12 w-full" onClick={onClose}>
          {t("common.ui.close")}
        </Button>
      }
    >
      <ChinaComingSoon />
    </SheetFrame>
  );
}
