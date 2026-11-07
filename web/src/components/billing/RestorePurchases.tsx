"use client";

/**
 * Restore Purchases (owner 2026-11-06, Apple style): one row on Billing.
 * The gateway resyncs this account's web purchases and repairs what's
 * missing, never charging; the answer is "Your purchases are restored" or
 * "We didn't find any purchases". App Store purchases can't be restored
 * in a browser, so the row always says where they show.
 */

import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { billingUidAtom } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

import { RESTORE_FAILED, restoreAtom, runRestoreAtom } from "./restoreAtoms";
import { RestoreMove } from "./RestoreMove";

/** English (tests); the row reads billing.restore.appStoreNote. */
export const APP_STORE_NOTE = "Purchases from the App Store show when you sign in to the app.";

export function RestorePurchases(): JSX.Element {
  const t = useT();
  const gateway = useGateway();
  const uid = useAppAtomValue(billingUidAtom);
  const state = useAppAtomValue(restoreAtom);
  const restore = useAppSetAtom(runRestoreAtom);
  const mine = state.uid === uid;
  const busy = mine && state.busy;
  const message = mine ? state.message : null;
  // the atom keeps the English retry line; a refusal's own words stay
  const error = mine && state.error !== null ? (state.error === RESTORE_FAILED ? t("billing.restore.failed") : state.error) : null;

  return (
    <section
      data-testid="restore-purchases"
      aria-labelledby="restore-title"
      className="flex flex-col gap-2 rounded-xl border border-edge bg-surface-1 p-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id="restore-title" className="text-sm font-semibold text-fg">
            {t("billing.restore.title")}
          </h2>
          <p className="text-sm text-fg-muted">{t("billing.restore.intro", { pro: "Pro" })}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || uid === null}
          onClick={() => void restore(gateway)}
          data-testid="restore-button"
        >
          {busy ? t("billing.restore.restoring") : t("billing.restore.button")}
        </Button>
      </div>
      <div role="status" aria-live="polite" className="text-sm">
        {message ? (
          <p data-testid="restore-message" className="text-fg">
            {message}
          </p>
        ) : null}
        {error ? (
          <p data-testid="restore-error" className="text-red-300">
            {error}
          </p>
        ) : null}
      </div>
      {/* gateway 00152: a plan from a deleted account, under another email */}
      <RestoreMove />
      <p className="text-xs text-fg-muted">{t("billing.restore.appStoreNote")}</p>
    </section>
  );
}
