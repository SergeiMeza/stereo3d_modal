"use client";

/**
 * Plans sheet C (plans canvas, 2026-11-04): Pro first, "Business for
 * work" as one row below. It opens after a free preview finishes, or when
 * the free previews are used up — at most once per browser session, never
 * for Pro, Business or Studio — and closes with one tap ("Keep paying per
 * video", ×, or outside). Closing also keeps it away for a day on the
 * account. Get Pro opens our own payment sheet; nothing is bought without
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
import { LocalPriceNote } from "@/components/pro/LocalPriceNote";
import { useT } from "@/lib/i18n/I18nProvider";
import { qualityName } from "@/lib/glossary";
import { creditLine, creditRules, planCadence, planName, proCreditCents, proCreditDays } from "@/lib/pro/plans";
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
  /** the quality to give the per-minute example at ("4K is $13.60 a minute instead of $16.00", from /v1/pricing) */
  preset: Preset;
  reason: "preview_done" | "previews_used";
}): JSX.Element | null {
  const t = useT();
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
  // owner 2026-11-07: the credit joining Pro gives, from /v1/pricing
  const credit = creditLine(proCreditCents(pricing), t);
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
      title={pct ? t("plans.sheet.titleWithPct", { pro: "Pro", pct }) : "Pro"}
      subtitle={
        listPer !== undefined && proPer !== undefined
          ? t("plans.sheet.perMinute", {
              quality: qualityName(preset, t),
              pro: formatCents(proPer, t),
              list: formatCents(listPer, t),
            })
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
            {t("plans.sheet.getPro", { pro: "Pro", plan: plan ? planName(plan, t) : "" })}
          </Button>
          <button
            type="button"
            data-testid="plans-sheet-keep"
            onClick={() => close("keep")}
            className="py-2 text-center text-sm text-primary hover:underline"
          >
            {t("plans.sheet.keepPaying")}
          </button>
          <p className="text-center text-xs text-fg-muted">
            {t("plans.sheet.termsNoTax")}
          </p>
          <LocalPriceNote testId="plans-sheet-local-note" className="text-center" />
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div
          role="radiogroup"
          aria-label={t("plans.sheet.planGroup", { pro: "Pro" })}
          className="flex flex-col gap-2"
        >
          {credit ? (
            <p data-testid="plans-sheet-credit" className="text-xs text-fg-muted">
              <span className="text-fg">{t("plans.sheet.includes", { pro: "Pro", credit })}</span> {creditRules(proCreditDays(pricing), t)}
            </p>
          ) : null}
          {plans.state === "loading" ? (
            <div className="h-40 animate-pulse rounded-xl bg-surface-2" />
          ) : null}
          {list.map((p) => {
            const on = plan?.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={on}
                data-testid={`plans-sheet-${p.kind}`}
                onClick={() => setPicked(p.id)}
                className={`flex min-h-[60px] items-center gap-3 rounded-[10px] border px-3.5 py-2 text-start ${
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
                  <span className="text-[15px] text-fg">{planName(p, t)}</span>
                  <span className="text-xs text-fg-muted">
                    {`${p.price} ${planCadence(p, t)}`}
                    {p.kind === "monthly" &&
                    pricing?.free_previews?.allowances?.pro_monthly
                      ? ` · ${t("plans.sheet.freePreviewsMonthly", { count: pricing.free_previews.allowances.pro_monthly })}`
                      : ""}
                  </span>
                </span>
                <span className="font-mono text-sm text-fg">
                  {p.price}
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
              <span className="font-medium text-fg">
                {t("plans.sheet.businessTitle", { business: "Business" })}
              </span>
              <span className="text-xs text-fg-muted">
                {maxFps && maxFps > 30
                  ? t("plans.sheet.businessLineFps", {
                      price: formatCentsShort(biz.price_cents ?? biz.monthly_cents, t),
                      credit: formatCentsShort(biz.credit_cents, t),
                      fps: maxFps,
                    })
                  : t("plans.sheet.businessLine", {
                      price: formatCentsShort(biz.price_cents ?? biz.monthly_cents, t),
                      credit: formatCentsShort(biz.credit_cents, t),
                    })}
              </span>
            </span>
            <ChevronRight className="size-4 text-fg-muted rtl:-scale-x-100" aria-hidden />
          </Link>
        ) : null}
      </div>
    </SheetFrame>
  );
}
