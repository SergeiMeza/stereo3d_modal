"use client";

/**
 * Business and Studio entry points (owner 2026-11-04): the /account card
 * for anyone without Business or Studio (Pro included), the /pro line,
 * and the quiet /account line while an App Store Pro is still active.
 */

import Link from "next/link";
import type { JSX } from "react";

import { businessSaveRange, usePlanTier } from "@/components/plans/upsell";
import { Button } from "@/components/ui/button";
import { usePricing } from "@/lib/api/usePricing";
import { useProStatus } from "@/lib/pro/usePro";

import { proCase } from "./BusinessSetup";

export const SETUP_PATH = "/account/business";

export function BusinessEntry(): JSX.Element | null {
  const tier = usePlanTier();
  if (tier !== "none" && tier !== "pro") return null;
  return (
    <section
      data-testid="business-entry"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface-1 p-4"
    >
      <p className="min-w-56 flex-1 text-sm text-fg">
        Using Spatial Video Studio for work? Set up Business or Studio
      </p>
      <Button asChild size="sm">
        <Link href={SETUP_PATH}>Set up</Link>
      </Button>
    </section>
  );
}

/** /pro: "Working for clients or a team? Business and Studio save 20–25%
 * and include commercial use. See plans". */
export function ProBusinessLine(): JSX.Element | null {
  const tier = usePlanTier();
  const range = businessSaveRange(usePricing());
  if (tier === "business" || tier === "studio" || !range) return null;
  return (
    <p data-testid="pro-business-line" className="text-sm text-fg-muted">
      Working for clients or a team? Business and Studio save {range} and
      include commercial use.{" "}
      <Link href={SETUP_PATH} className="text-primary hover:underline">
        See plans
      </Link>
    </p>
  );
}

/** While an App Store Pro is still active, how to cancel it. */
export function AppStoreProLine(): JSX.Element | null {
  const pro = useProStatus();
  if (proCase(pro) !== "app_store") return null;
  return (
    <p data-testid="app-store-pro-line" className="pt-2 text-xs text-fg-muted">
      Pro from the App Store is still active.{" "}
      {pro?.management_url ? (
        <a
          href={pro.management_url}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          How to cancel
        </a>
      ) : null}
    </p>
  );
}
