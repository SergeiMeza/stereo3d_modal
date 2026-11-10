"use client";

/**
 * Header B (plans canvas, 2026-11-04): a Plans link, and for people
 * without a plan a "Save 15–25%" chip inside it (one link, no popover).
 * The range comes from /v1/pricing's tier shares. On phones the chip
 * stands alone beside the logo.
 *
 * Owner 2026-11-05: only people without a plan (and signed-out visitors)
 * see it; subscribers find Plans in the account menu. Nothing renders
 * while the session or the tier is still loading, so the link never
 * flashes in and out.
 *
 * Never on /app (WEB-02, owner 2026-11-10): the apps link there, and App
 * Review wants that page to introduce the web app, not sell plans.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { JSX } from "react";

import { useAuth } from "@/lib/auth";
import { usePricing } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";

import {
  saveRange,
  usePaywallEvents,
  usePlanTier,
  useViewEvent,
} from "./upsell";

/** Who gets the header link: "none" with the chip, signed out without,
 * null for subscribers and while loading. */
export function useHeaderPlans(): "none" | "signed_out" | null {
  const { user, ready } = useAuth();
  const tier = usePlanTier();
  if (!ready) return null;
  if (user === null) return "signed_out";
  return tier === "none" ? "none" : null;
}

/** Pages that must show no plans or prices in the header. */
const NO_PLANS_PATHS: ReadonlySet<string> = new Set(["/app"]);

export function HeaderPlans(): JSX.Element | null {
  const who = useHeaderPlans();
  const pathname = usePathname();
  if (pathname !== null && NO_PLANS_PATHS.has(pathname)) return null;
  return who === null ? null : <HeaderPlansLink withChip={who === "none"} />;
}

function HeaderPlansLink({ withChip }: { withChip: boolean }): JSX.Element {
  const t = useT();
  const tier = usePlanTier();
  const range = saveRange(usePricing());
  const chip = withChip && range !== null;
  useViewEvent("header", tier, chip, { variant: "save_chip" });
  const send = usePaywallEvents("header", tier, { variant: "save_chip" });
  return (
    <Link
      href="/plans"
      data-testid="header-plans"
      onClick={() => chip && send("click", { target: "/plans" })}
      // owner 2026-11-07 (foldable): the chip gives way before the header
      // grows wider than the screen (a longer "Save" in fr, ru)
      className="flex min-w-0 items-center gap-2 text-fg-muted transition-colors hover:text-fg"
    >
      <span className="hidden shrink-0 sm:inline">{t("plans.header.link")}</span>
      {chip ? (
        <span
          data-testid="header-save-chip"
          className="min-w-0 truncate rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
        >
          {t("plans.header.save", { range })}
        </span>
      ) : (
        <span className="sm:hidden">{t("plans.header.link")}</span>
      )}
    </Link>
  );
}
