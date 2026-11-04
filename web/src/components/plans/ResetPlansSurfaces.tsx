"use client";

/**
 * Test environments only (owner 2026-11-04): bring every plans surface
 * back — PATCH /v1/account/settings dismissed {placement: null} for each
 * placement, and forget this session's plans sheet. Never in production.
 */

import { useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { useAccountSettings } from "@/lib/useAccountSettings";

import { SESSION_KEY } from "./PlansSheet";

const PLACEMENTS = [
  "header",
  "projects_banner",
  "quote",
  "receipt",
  "plans_sheet",
  "business_note",
  "business_banner",
  "plans_hint",
] as const;

export const TEST_ENV =
  process.env.NEXT_PUBLIC_API_MOCK === "1" ||
  (process.env.NEXT_PUBLIC_VERCEL_ENV ?? "production") !== "production";

export function ResetPlansSurfaces(): JSX.Element | null {
  const { update } = useAccountSettings();
  const [done, setDone] = useState(false);
  if (!TEST_ENV) return null;
  return (
    <div data-testid="reset-plans" className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-amber-500/50 p-3 text-xs">
      <span className="text-amber-300">Test only</span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          update({ dismissed: Object.fromEntries(PLACEMENTS.map((p) => [p, null])) });
          try {
            window.sessionStorage.removeItem(SESSION_KEY);
          } catch {
            // nothing to forget
          }
          setDone(true);
        }}
      >
        Reset plans surfaces
      </Button>
      {done ? <span className="text-fg-muted">All plans surfaces will show again.</span> : null}
    </div>
  );
}
