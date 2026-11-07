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
 * around. In China mode (lib/region.ts) nothing runs at all, so no banner
 * either.
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
import { useT } from "@/lib/i18n/I18nProvider";
import { rich } from "@/lib/i18n/rich";
import { currentRegion } from "@/lib/region";

export function Analytics() {
  const t = useT();
  const [banner, setBanner] = useState(false);

  useEffect(() => {
    if (!ANALYTICS_ENABLED || currentRegion() === "cn") return;
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
      aria-label={t("common.analytics.bannerLabel")}
      // eslint-disable-next-line no-restricted-syntax -- a full-width bar pinned to the bottom edge, not an anchored overlay; it can't clip
      className="fixed inset-x-0 bottom-0 z-50 border-t border-edge bg-surface-1 pointer-fine:bg-surface-1/95 pointer-fine:backdrop-blur"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 text-sm">
        <p className="min-w-64 flex-1 text-fg-muted">
          {rich(t, "common.analytics.banner", {
            link: (c) => (
              <Link href="/privacy" className="text-primary hover:underline">
                {c}
              </Link>
            ),
          })}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => choose("denied")}
            className="rounded-md border border-edge px-4 py-2 font-medium text-fg transition-colors hover:bg-surface-2"
          >
            {t("common.analytics.deny")}
          </button>
          <button
            type="button"
            onClick={() => choose("granted")}
            className="rounded-md border border-edge px-4 py-2 font-medium text-fg transition-colors hover:bg-surface-2"
          >
            {t("common.analytics.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
