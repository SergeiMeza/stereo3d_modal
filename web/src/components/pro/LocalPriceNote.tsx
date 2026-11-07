"use client";

/**
 * "You'll see your local price at checkout." under a Pro price (owner
 * 2026-11-07, Option B): the price shows in US dollars and Stripe offers
 * the local one when paying. Only while GET /v1/pricing says
 * adaptive_pricing; nothing otherwise.
 */

import type { JSX } from "react";

import { useLocalPriceAtCheckout } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";
import { cn } from "@/lib/utils";

export function LocalPriceNote({ testId, className }: { testId: string; className?: string }): JSX.Element | null {
  const t = useT();
  const on = useLocalPriceAtCheckout();
  if (!on) return null;
  return (
    <p data-testid={testId} className={cn("text-xs text-fg-muted", className)}>
      {t("pay.copy.localAtCheckout")}
    </p>
  );
}
