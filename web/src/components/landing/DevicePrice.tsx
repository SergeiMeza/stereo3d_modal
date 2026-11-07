"use client";

/**
 * The device pages' line under the button (S3D-51/05): "any length, up
 * to 8K", from GET /v1/pricing — nothing until it answers. No price here
 * (owner 2026-11: prices live on /pricing, /plans and the quote).
 */

import type { JSX } from "react";

import { methodLimitText } from "@/components/steps/methods";
import { fromPerMinute, usePricing } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";

export function DevicePrice(): JSX.Element | null {
  const t = useT();
  const pricing = usePricing();
  const from = pricing ? fromPerMinute(pricing) : null;
  if (!pricing || from === null) return null;
  return (
    <span data-testid="device-price" className="text-sm text-fg-muted">
      {methodLimitText("lifelike", null, pricing, t)}
    </span>
  );
}
