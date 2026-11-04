"use client";

/**
 * Plans sheet C (plans canvas, 2026-11-04): Pro first, "Business for
 * work" as one row below. It opens after a free preview finishes, or when
 * the free previews are used up — at most once per browser session, never
 * for Pro, Business or Studio — and closes with one tap ("Keep paying per
 * video", ×, or outside). Closing also keeps it away for a day on the
 * account. Get Pro opens RevenueCat's checkout; nothing is bought without
 * that tap. Larger targets in a headset browser (SheetFrame).
 */

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { SheetFrame } from "@/components/pay/SheetFrame";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { Preset } from "@/lib/api/types";
import { usePricing } from "@/lib/api/usePricing";
import { qualityName } from "@/lib/glossary";
import { introLine, planCadence, planName } from "@/lib/pro/plans";
import { useBuyPro, useProPlans } from "@/lib/pro/usePro";

import {
  proPct,
  useDismissal,
  usePaywallEvents,
  usePlanTier,
  useViewEvent,
} from "./upsell";

export const SESSION_KEY = "svs-plans-sheet-shown";

function shownThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function markShown(): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, "1");
  } catch {
    // storage blocked: it may show once more, never more than per page
  }
}

/** Opens the sheet once when `trigger` turns true (and it may show). */
export function usePlansSheet(trigger: boolean): {
  open: boolean;
  close: () => void;
} {
  const tier = usePlanTier();
  const { dismissed, dismiss } = useDismissal("plans_sheet", 1);
  const [open, setOpen] = useState(false);
  const may = tier === "none" && dismissed === false;
  useEffect(() => {
    if (!trigger || !may || open || shownThisSession()) return;
    markShown();
    const t = setTimeout(() => setOpen(true), 0);
    return () => clearTimeout(t);
  }, [trigger, may, open]);
  return {
    open,
    close: () => {
      setOpen(false);
      dismiss();
    },
  };
}

export function PlansSheet({
  open,
  onClose,
  preset,
  reason,
}: {
  open: boolean;
  onClose: () => void;
  /** the quality to give the per-minute example at ("4K is $8.50 …") */
  preset: Preset;
  reason: "preview_done" | "previews_used";
}): JSX.Element | null {
  const tier = usePlanTier();
  const pricing = usePricing();
  const plans = useProPlans();
  const buy = useBuyPro();
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useViewEvent("plans_sheet", tier, open, { variant: reason });
  const send = usePaywallEvents("plans_sheet", tier, { variant: reason });
  if (!open) return null;
  const pct = proPct(pricing);
  const rates = pricing?.tiers?.lifelike_cents_per_minute;
  const listPer = rates?.list?.[preset];
  const proPer = rates?.pro?.[preset];
  const list = plans.state === "ready" ? plans.plans : [];
  const plan =
    list.find((p) => p.id === picked) ??
    list.find((p) => p.kind === "monthly") ??
    list[0];
  const biz = pricing?.plans?.business;
  const maxFps = biz?.max_fps ?? pricing?.fps.max_fps_with_plan;

  const close = (how: string): void => {
    send("dismiss", { target: how });
    onClose();
  };

  return (
    <SheetFrame
      open
      testId="plans-sheet"
      onClose={() => close("x")}
      locked={busy}
      title={pct ? `Pro · ${pct}% off every video` : "Pro"}
      subtitle={
        listPer !== undefined && proPer !== undefined
          ? `${qualityName(preset)} is ${formatCents(proPer)} a minute instead of ${formatCents(listPer)}.`
          : undefined
      }
      footer={
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            className="h-12 w-full"
            data-testid="plans-sheet-get"
            disabled={!plan || busy}
            onClick={async () => {
              if (!plan) return;
              setBusy(true);
              send("click", { target: `get_pro_${plan.kind}` });
              try {
                if ((await buy(plan)) === "purchased") onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            Get Pro {plan ? planName(plan) : ""}
          </Button>
          <button
            type="button"
            data-testid="plans-sheet-keep"
            onClick={() => close("keep")}
            className="py-2 text-center text-sm text-primary hover:underline"
          >
            Keep paying per video
          </button>
          <p className="text-center text-xs text-fg-muted">
            USD, excl. tax · cancel any time in Account
          </p>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div
          role="radiogroup"
          aria-label="Pro plan"
          className="flex flex-col gap-2"
        >
          {plans.state === "loading" ? (
            <div className="h-40 animate-pulse rounded-xl bg-surface-2" />
          ) : null}
          {list.map((p) => {
            const on = plan?.id === p.id;
            const intro = introLine(p);
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={on}
                data-testid={`plans-sheet-${p.kind}`}
                onClick={() => setPicked(p.id)}
                className={`flex min-h-[60px] items-center gap-3 rounded-[10px] border px-3.5 py-2 text-left ${
                  on
                    ? "border-primary bg-primary/10"
                    : "border-edge hover:border-fg-muted"
                }`}
              >
                <span
                  aria-hidden
                  className={`size-4 shrink-0 rounded-full ${on ? "border-[5px] border-primary" : "border-[1.5px] border-fg-muted"}`}
                />
                <span className="flex flex-1 flex-col">
                  <span className="text-[15px] text-fg">{planName(p)}</span>
                  <span className="text-xs text-fg-muted">
                    {intro
                      ? `${intro}, then ${p.price}`
                      : `${p.price} ${planCadence(p)}`}
                    {p.kind === "monthly" &&
                    pricing?.free_previews?.allowances?.pro_monthly
                      ? ` · ${pricing.free_previews.allowances.pro_monthly} free previews a month`
                      : ""}
                  </span>
                </span>
                <span className="font-mono text-sm text-fg">
                  {p.intro?.price ?? p.price}
                </span>
              </button>
            );
          })}
        </div>
        {biz ? (
          <Link
            href="/plans"
            data-testid="plans-sheet-business"
            onClick={() => {
              send("click", { target: "/plans" });
              onClose();
            }}
            className="flex items-center gap-3 rounded-[10px] border border-edge px-3.5 py-3 text-sm hover:border-fg-muted"
          >
            <span className="flex flex-1 flex-col">
              <span className="font-medium text-fg">Business for work</span>
              <span className="text-xs text-fg-muted">
                {formatCentsShort(biz.price_cents ?? biz.monthly_cents)} a month
                with {formatCentsShort(biz.credit_cents)} of usage, commercial use
                {maxFps && maxFps > 30 ? `, ${maxFps} fps` : ""}, invoices
              </span>
            </span>
            <ChevronRight className="size-4 text-fg-muted" aria-hidden />
          </Link>
        ) : null}
      </div>
    </SheetFrame>
  );
}
