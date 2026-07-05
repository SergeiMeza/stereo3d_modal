"use client";

/**
 * Analytics bootstrap, mounted once in the root layout. Renders nothing
 * except, for UK/EEA visitors with no stored choice, the consent banner.
 *
 * Decision on mount (production only — see ANALYTICS_ENABLED):
 *   stored "granted"        → start, with Clarity's consent signal
 *   stored "denied"         → nothing
 *   no stored choice        → GET /api/geo (Vercel geolocation header):
 *     consent not required  → start silently
 *     consent required      → show the banner; start only on "Allow"
 * A failed geo lookup counts as consent-required — the privacy-safe way
 * around.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  ANALYTICS_ENABLED,
  startAnalytics,
  storeConsent,
  storedConsent,
} from "@/lib/analytics";
import type { ConsentChoice } from "@/lib/analytics";

export function Analytics() {
  const [banner, setBanner] = useState(false);

  useEffect(() => {
    if (!ANALYTICS_ENABLED) return;
    const choice = storedConsent();
    if (choice === "granted") {
      startAnalytics({ consented: true });
      return;
    }
    if (choice === "denied") return;
    fetch("/api/geo")
      .then(
        (res): Promise<{ requires_consent?: boolean }> =>
          res.ok ? res.json() : Promise.resolve({}),
      )
      .then((geo) => {
        if (geo.requires_consent === false) {
          startAnalytics({ consented: false });
        } else {
          setBanner(true);
        }
      })
      .catch(() => setBanner(true));
  }, []);

  if (!banner) return null;

  const choose = (choice: ConsentChoice): void => {
    storeConsent(choice);
    setBanner(false);
    if (choice === "granted") startAnalytics({ consented: true });
  };

  return (
    <div
      role="region"
      aria-label="Analytics consent"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-edge bg-surface-1/95 backdrop-blur"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 text-sm">
        <p className="min-w-64 flex-1 text-fg-muted">
          Can we use analytics cookies? Google Analytics and Microsoft
          Clarity show us how the studio is used so we can improve it — no
          advertising, and never the content of your videos.{" "}
          <Link href="/privacy" className="text-primary hover:underline">
            Privacy Policy
          </Link>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => choose("denied")}
            className="rounded-md border border-edge px-4 py-2 font-medium text-fg transition-colors hover:bg-surface-2"
          >
            No thanks
          </button>
          <button
            type="button"
            onClick={() => choose("granted")}
            className="rounded-md border border-edge px-4 py-2 font-medium text-fg transition-colors hover:bg-surface-2"
          >
            Allow analytics
          </button>
        </div>
      </div>
    </div>
  );
}
