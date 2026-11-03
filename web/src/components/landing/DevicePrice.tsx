"use client";

/**
 * The device pages' price line (S3D-51/15/05): "from $3 a minute at 24
 * fps · any length, up to 8K", from GET /v1/pricing — nothing until it
 * answers.
 */

import type { JSX } from "react";

import { methodLimitText } from "@/components/steps/methods";
import { formatCentsShort } from "@/components/steps/money";
import { fromPerMinute, usePricing } from "@/lib/api/usePricing";

export function DevicePrice(): JSX.Element | null {
  const pricing = usePricing();
  const from = pricing ? fromPerMinute(pricing) : null;
  if (!pricing || from === null) return null;
  return (
    <span data-testid="device-price" className="text-sm text-fg-muted">
      from {formatCentsShort(from)} a minute at {pricing.fps.base} fps ·{" "}
      {methodLimitText("lifelike", null, pricing)}
    </span>
  );
}
