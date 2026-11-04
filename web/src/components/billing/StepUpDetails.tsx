"use client";

/**
 * A step-up's price, from POST /v1/plans/preview-change only (owner
 * 2026-11-04): "Today: $11,950.62. Studio $11,988.00 − $37.38 for your
 * unused Business.", "How we work this out" (the credit rule), and for a
 * plan with monthly usage "Your remaining Business usage this month ends
 * when Studio's $1,500 starts." Renewal date below.
 */

import type { JSX } from "react";

import { InfoPopover } from "@/components/ui/info-popover";
import type { PlanChangePreview } from "@/lib/api/client";

import {
  changeDate,
  CREDIT_RULE,
  upgradeLine,
  usageHandoverLine,
} from "./planChangeCopy";

export function StepUpDetails({
  preview,
  from,
  to,
  /** the new plan's monthly usage, when both plans have usage */
  handoverCreditCents,
  testId,
}: {
  preview: PlanChangePreview;
  from: string;
  to: string;
  handoverCreditCents?: number | null;
  testId?: string;
}): JSX.Element {
  const credit = (preview.unused_credit_cents ?? 0) > 0;
  return (
    <div className="flex flex-col gap-1.5 text-sm" data-testid={testId}>
      <p
        className="text-fg"
        data-testid={testId ? `${testId}-line` : undefined}
      >
        {upgradeLine(preview, { from, to })}
      </p>
      {credit ? (
        <InfoPopover label="How we work this out">
          <p>{CREDIT_RULE}</p>
        </InfoPopover>
      ) : null}
      {handoverCreditCents ? (
        <p className="text-fg-muted">
          {usageHandoverLine(from, to, handoverCreditCents)}
        </p>
      ) : null}
      {preview.renews_at ? (
        <p className="text-xs text-fg-muted">
          Renews on {changeDate(preview.renews_at)}.
        </p>
      ) : null}
    </div>
  );
}

/** The parts under the line (for dialogs whose description is the line). */
export function StepUpExtras({
  preview,
  from,
  to,
  handoverCreditCents,
}: {
  preview: PlanChangePreview;
  from: string;
  to: string;
  handoverCreditCents?: number | null;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {(preview.unused_credit_cents ?? 0) > 0 ? (
        <InfoPopover label="How we work this out">
          <p>{CREDIT_RULE}</p>
        </InfoPopover>
      ) : null}
      {handoverCreditCents ? (
        <p className="text-fg-muted">
          {usageHandoverLine(from, to, handoverCreditCents)}
        </p>
      ) : null}
      {preview.renews_at ? (
        <p className="text-xs text-fg-muted">
          Renews on {changeDate(preview.renews_at)}.
        </p>
      ) : null}
    </div>
  );
}
