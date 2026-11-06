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
import { useAccountSettings } from "@/lib/useAccountSettings";

export const HINTS = {
  billing: "Your balance, payment methods and receipts. Top up here, or let your balance reload by itself.",
  usage: "Every run with its price, month by month. Download a CSV for your records.",
  invoices: "Invoices for your top-ups and plans, ready to download.",
  plans: "Plans lower the price of every run and include usage every month. Paying per video works without one.",
  pricing: "Prices are per minute of video at the size you pick. You always see the exact price before you pay.",
  pro: "Pro is one membership for the web and the apps. Members pay less for every run and get usage credit when they join.",
  account: "Your sign-in, your settings and, if you ever need it, deleting your account.",
  devices: "How to watch your 3D videos on this device.",
  scenes: "Where your video's scenes change. Previews and parts start at these points; you rarely need to change them.",
} as const;

export type HintId = keyof typeof HINTS;

export function FirstTimeHint({ id, className = "" }: { id: HintId; className?: string }): JSX.Element | null {
  const { user } = useAuth();
  const { settings, update } = useAccountSettings();
  if (!user || !settings || (settings.hints_seen ?? []).includes(id)) return null;
  return (
    <div
      role="note"
      data-testid={`hint-${id}`}
      className={`flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3.5 py-2.5 text-sm text-fg ${className}`}
    >
      <span className="flex-1">{HINTS[id]}</span>
      <button
        type="button"
        aria-label="Dismiss this tip"
        onClick={() => update({ hints_seen_add: [id] })}
        className="shrink-0 rounded p-0.5 text-fg-muted hover:text-fg"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
