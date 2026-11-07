"use client";

/**
 * P13 Delete account with dues (spec v6 G2/B12): POST /v1/account/delete
 * answers 402 balance_due {amount_cents}; the account page shows this
 * notice, Pay $X opens the settle sheet (P2) and, once paid, the delete
 * runs again ("Deleting your account…"). Exported for the account page.
 */

import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN } from "@/lib/i18n/t";

import { useSettle } from "./SettleSheet";

export const DUES_LINE = EN("pay.deleteDues.dues");
export const ACTIVE_RUNS_LINE = EN("pay.deleteDues.activeRuns");
export const DELETING = EN("pay.deleteDues.deleting");

export function DeleteDues({
  amountCents,
  onPaid,
}: {
  amountCents: number;
  /** called once the settle is paid: run the delete again */
  onPaid: () => void;
}): JSX.Element {
  const { openSettle } = useSettle();
  const t = useT();
  return (
    <div data-testid="delete-dues" className="flex flex-col gap-3 text-sm">
      <p className="text-fg">{t("pay.deleteDues.dues")}</p>
      <Button
        className="w-fit bg-red-400 text-zinc-950 tabular-nums hover:bg-red-300"
        onClick={() => openSettle(onPaid)}
      >
        {t("pay.deleteDues.pay", { amount: formatCents(amountCents, t) })}
      </Button>
    </div>
  );
}
