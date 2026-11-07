"use client";

/**
 * A first-time hint (owner 2026-11-04): one short line at the top of a
 * page or tab the first time someone signed in opens it, with × to
 * dismiss. Dismissed ids are saved on the account (settings.hints_seen),
 * so they stay gone on every device. Signed out, nothing shows.
 */

import { X } from "lucide-react";
import type { JSX } from "react";

import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n/I18nProvider";
import { useAccountSettings } from "@/lib/useAccountSettings";

/** Each hint's message (onboarding.hints.<id> in messages/en.json). */
export const HINTS = {
  billing: "onboarding.hints.billing",
  usage: "onboarding.hints.usage",
  invoices: "onboarding.hints.invoices",
  plans: "onboarding.hints.plans",
  pricing: "onboarding.hints.pricing",
  pro: "onboarding.hints.pro",
  account: "onboarding.hints.account",
  devices: "onboarding.hints.devices",
  scenes: "onboarding.hints.scenes",
} as const;

export type HintId = keyof typeof HINTS;

export function FirstTimeHint({ id, className = "" }: { id: HintId; className?: string }): JSX.Element | null {
  const t = useT();
  const { user } = useAuth();
  const { settings, update } = useAccountSettings();
  if (!user || !settings || (settings.hints_seen ?? []).includes(id)) return null;
  return (
    <div
      role="note"
      data-testid={`hint-${id}`}
      className={`flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3.5 py-2.5 text-sm text-fg ${className}`}
    >
      <span className="flex-1">{t(HINTS[id], { pro: "Pro" })}</span>
      <button
        type="button"
        aria-label={t("onboarding.hints.dismiss")}
        onClick={() => update({ hints_seen_add: [id] })}
        className="shrink-0 rounded p-0.5 text-fg-muted hover:text-fg"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
