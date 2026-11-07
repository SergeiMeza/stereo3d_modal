"use client";

/**
 * "Support moved your Studio plan here. Accept it?" (gateway 00155,
 * RP-05): a plan support offered to move to this account after checking
 * who owns it. What moves, what stays, valid until; Accept moves it
 * (Confirm it's you after an old sign-in). A refusal shows the gateway's
 * words and the offer stays; an expired one says to contact support.
 */

import { useEffect } from "react";
import type { JSX } from "react";

import { supportMailto } from "@/components/billing/BillingBanner";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { billingUidAtom } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

import { longDate } from "./PlanCard";
import { acceptPlanMoveAtom, loadPlanMovesAtom, MOVE_FAILED, planMovesAtom } from "./planMoveAtoms";
import { MOVES, planName, STAYS } from "./RestoreMove";

export function PlanMoveOffers(): JSX.Element | null {
  const t = useT();
  const gateway = useGateway();
  const uid = useAppAtomValue(billingUidAtom);
  const state = useAppAtomValue(planMovesAtom);
  const load = useAppSetAtom(loadPlanMovesAtom);
  const accept = useAppSetAtom(acceptPlanMoveAtom);
  useEffect(() => {
    if (uid !== null) void load(gateway);
  }, [uid, gateway, load]);
  const s = state.uid === uid ? state : null;
  // MOVES / STAYS hold message keys (RestoreMove); an id we don't know shows as sent
  const line = (keys: Record<string, string>, m: string) => (keys[m] ? t(keys[m], { pro: "Pro" }) : m);
  if (!s?.offers || s.offers.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {s.offers.map((o) => {
        const name = planName(o.plan);
        const carry = (o.carry_cents ?? 0) > 0 ? ` (${formatCents(o.carry_cents!, t)})` : "";
        if (s.accepted.includes(o.id)) {
          return (
            <p key={o.id} role="status" data-testid={`plan-move-${o.id}`} className="rounded-xl border border-edge bg-surface-1 p-4 text-sm text-fg">
              {t("billing.planMove.accepted", { name })}
            </p>
          );
        }
        const expired = s.expired.includes(o.id);
        const raw = s.errors[o.id];
        // the atom keeps its own fallback in English; the gateway's words show as sent
        const error = raw === MOVE_FAILED ? t("billing.planMove.moveFailed") : raw;
        return (
          <section
            key={o.id}
            data-testid={`plan-move-${o.id}`}
            aria-label={t("billing.planMove.sectionLabel")}
            className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-primary/5 p-5 text-sm"
          >
            <p className="font-semibold text-fg">{t("billing.planMove.headline", { name })}</p>
            <p className="text-fg-muted">{t("billing.planMove.validUntil", { date: longDate(o.ends_at, t) })}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="text-xs text-fg-muted">{t("billing.planMove.whatMoves")}</p>
                <ul className="list-disc pl-4 text-fg">
                  {o.moves.map((m) => (
                    <li key={m}>
                      {line(MOVES, m)}
                      {m === "current_usage" ? carry : ""}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs text-fg-muted">{t("billing.planMove.whatStays")}</p>
                <ul className="list-disc pl-4 text-fg-muted">
                  {o.stays.map((m) => (
                    <li key={m}>{line(STAYS, m)}</li>
                  ))}
                </ul>
              </div>
            </div>
            {expired ? (
              <p role="alert" className="text-red-300">
                {t("billing.planMove.expired")}{" "}
                <a href={supportMailto(`Plan move ${o.id}`)} className="text-primary underline underline-offset-2">
                  {t("billing.planMove.contactSupport")}
                </a>
              </p>
            ) : (
              <>
                {error ? (
                  <p role="alert" className="text-red-300">
                    {error}
                  </p>
                ) : null}
                <Button size="sm" className="self-start" onClick={() => void accept({ client: gateway, id: o.id })}>
                  {t("billing.planMove.accept")}
                </Button>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
