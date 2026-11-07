"use client";

/**
 * The analytics choice on the Privacy page (UK GDPR: withdrawing consent
 * must be as easy as giving it; owner 2026-11-04).
 *
 * - UK/EEA (GET /api/geo requires_consent, or an unknown region): "reset
 *   your analytics choice" clears the stored choice and reloads, so the
 *   consent banner asks again.
 * - Elsewhere analytics start silently, so a reset would do nothing
 *   visible there: an inline switch instead. Off stores "denied" and
 *   reloads (Clarity is gone after the reload); on stores "granted" and
 *   starts it.
 */

import { useEffect, useState } from "react";

import {
  clearStoredConsent,
  startAnalytics,
  storeConsent,
  storedConsent,
} from "@/lib/analytics";
import { useT } from "@/lib/i18n/I18nProvider";

type Mode = "loading" | "banner" | "switch";

export function AnalyticsChoice() {
  const t = useT();
  const [mode, setMode] = useState<Mode>("loading");
  // read once on the client (the page renders before any choice shows)
  const [on, setOn] = useState(() =>
    typeof window === "undefined" ? true : storedConsent() !== "denied",
  );

  useEffect(() => {
    let live = true;
    fetch("/api/geo")
      .then(
        (res): Promise<{ requires_consent?: boolean }> =>
          res.ok ? res.json() : Promise.resolve({}),
      )
      .then((geo) => live && setMode(geo.requires_consent === false ? "switch" : "banner"))
      .catch(() => live && setMode("banner"));
    return () => {
      live = false;
    };
  }, []);

  if (mode === "switch") {
    return (
      <span className="inline-flex items-center gap-2 align-middle">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t("common.analytics.switchLabel")}
          data-testid="analytics-switch"
          onClick={() => {
            if (on) {
              storeConsent("denied");
              setOn(false);
              window.location.reload();
            } else {
              storeConsent("granted");
              setOn(true);
              startAnalytics({ consented: true });
            }
          }}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            on ? "bg-primary" : "bg-surface-2"
          }`}
        >
          <span
            className={`inline-block size-4 rounded-full bg-white transition-transform ${
              on ? "translate-x-4 rtl:-translate-x-4" : "translate-x-0.5 rtl:-translate-x-0.5"
            }`}
          />
        </button>
        <span className="text-fg">{on ? t("common.analytics.switchOn") : t("common.analytics.switchOff")}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="analytics-reset"
      onClick={() => {
        clearStoredConsent();
        window.location.reload();
      }}
      className="text-primary hover:underline"
    >
      {t("common.analytics.reset")}
    </button>
  );
}
