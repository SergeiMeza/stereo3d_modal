"use client";

/**
 * Inline "change your analytics choice" control for the privacy policy —
 * consent withdrawal must be as easy as giving it (UK GDPR). Clears the
 * stored choice and reloads, so the consent banner asks again (and, for a
 * previous "allow", the SDKs are gone after the reload).
 */

import { clearStoredConsent } from "@/lib/analytics";

export function AnalyticsChoiceReset() {
  return (
    <button
      type="button"
      onClick={() => {
        clearStoredConsent();
        window.location.reload();
      }}
      className="text-primary hover:underline"
    >
      reset your analytics choice
    </button>
  );
}
