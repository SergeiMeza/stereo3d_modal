"use client";

/**
 * Test environments only (owner 2026-11-04), never in production:
 * - Reset plans surfaces: PATCH dismissed {placement: null} for each
 *   placement, and forget this session's plans sheet.
 * - Simulate app Pro: PATCH simulate_app_pro on/off; GET /v1/pro and the
 *   onboarding variant follow on the gateway.
 * - Show welcome again: PATCH onboarding welcome_done / app_pro_welcome_done
 *   false; the next Projects visit in this tab opens it, even on an account
 *   that already has projects.
 */

import { useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { notifyProChanged } from "@/lib/pro/usePro";
import { useAccountSettings } from "@/lib/useAccountSettings";

import { SESSION_KEY } from "./PlansSheet";
import { clearLocalProjectDismissals } from "./upsell";

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

const WELCOME_AGAIN_KEY = "svs-welcome-again";

/** "Show welcome again" was pressed in this tab (test only). */
export function welcomeAgainRequested(): boolean {
  if (!TEST_ENV) return false;
  try {
    return window.sessionStorage.getItem(WELCOME_AGAIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearWelcomeAgain(): void {
  try {
    window.sessionStorage.removeItem(WELCOME_AGAIN_KEY);
  } catch {
    // nothing to forget
  }
}

export function ResetPlansSurfaces(): JSX.Element | null {
  const { settings, update, refresh } = useAccountSettings();
  const gateway = useGateway();
  const [done, setDone] = useState<string | null>(null);
  if (!TEST_ENV) return null;
  const simulated = settings?.simulate_app_pro === true;
  return (
    <div
      data-testid="reset-plans"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-amber-500/50 p-3 text-xs"
    >
      <span className="text-amber-300">Test only</span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          // the placements and every per-project Business note key
          const perProject = Object.keys(settings?.dismissed ?? {}).filter((k) =>
            k.startsWith("business_note:"),
          );
          update({
            dismissed: Object.fromEntries([...PLACEMENTS, ...perProject].map((p) => [p, null])),
          });
          clearLocalProjectDismissals();
          try {
            window.sessionStorage.removeItem(SESSION_KEY);
          } catch {
            // nothing to forget
          }
          setDone("All plans surfaces will show again.");
        }}
      >
        Reset plans surfaces
      </Button>
      <Button
        size="sm"
        variant="outline"
        role="switch"
        aria-checked={simulated}
        data-testid="simulate-app-pro"
        disabled={settings === null}
        onClick={() => {
          // saved first, then GET /v1/pro and the settings again
          void gateway
            .patchAccountSettings({ simulate_app_pro: !simulated })
            .then(() => {
              notifyProChanged();
              refresh();
            })
            .catch(() => setDone("Couldn't change the simulation."));
          setDone(
            simulated
              ? "App Pro simulation off."
              : "Simulating app Pro. Open Projects for the welcome.",
          );
        }}
      >
        Simulate app Pro: {simulated ? "on" : "off"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        data-testid="show-welcome-again"
        onClick={() => {
          update({
            onboarding: { welcome_done: false, app_pro_welcome_done: false },
          });
          try {
            window.sessionStorage.setItem(WELCOME_AGAIN_KEY, "1");
          } catch {
            // the gateway flags still bring it back on a new account
          }
          setDone("The welcome opens on your next visit to Projects.");
        }}
      >
        Show welcome again
      </Button>
      {done ? <span className="text-fg-muted">{done}</span> : null}
    </div>
  );
}
