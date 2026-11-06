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
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

import { longDate } from "./PlanCard";
import { acceptPlanMoveAtom, loadPlanMovesAtom, MOVE_EXPIRED, planMovesAtom } from "./planMoveAtoms";
import { MOVES, planName, STAYS } from "./RestoreMove";

export function PlanMoveOffers(): JSX.Element | null {
  const gateway = useGateway();
  const uid = useAppAtomValue(billingUidAtom);
  const state = useAppAtomValue(planMovesAtom);
  const load = useAppSetAtom(loadPlanMovesAtom);
  const accept = useAppSetAtom(acceptPlanMoveAtom);
  useEffect(() => {
    if (uid !== null) void load(gateway);
  }, [uid, gateway, load]);
  const s = state.uid === uid ? state : null;
  if (!s?.offers || s.offers.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {s.offers.map((o) => {
        const name = planName(o.plan);
        const carry = (o.carry_cents ?? 0) > 0 ? ` (${formatCents(o.carry_cents!)})` : "";
        if (s.accepted.includes(o.id)) {
          return (
            <p key={o.id} role="status" data-testid={`plan-move-${o.id}`} className="rounded-xl border border-edge bg-surface-1 p-4 text-sm text-fg">
              Your {name} plan is here.
            </p>
          );
        }
        const expired = s.expired.includes(o.id);
        const error = s.errors[o.id];
        return (
          <section
            key={o.id}
            data-testid={`plan-move-${o.id}`}
            aria-label="A plan support moved to you"
            className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-primary/5 p-5 text-sm"
          >
            <p className="font-semibold text-fg">Support moved your {name} plan here. Accept it?</p>
            <p className="text-fg-muted">Valid until {longDate(o.ends_at)}.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="text-xs text-fg-muted">What moves here</p>
                <ul className="list-disc pl-4 text-fg">
                  {o.moves.map((m) => (
                    <li key={m}>
                      {MOVES[m] ?? m}
                      {m === "current_usage" ? carry : ""}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs text-fg-muted">What stays</p>
                <ul className="list-disc pl-4 text-fg-muted">
                  {o.stays.map((m) => (
                    <li key={m}>{STAYS[m] ?? m}</li>
                  ))}
                </ul>
              </div>
            </div>
            {expired ? (
              <p role="alert" className="text-red-300">
                {MOVE_EXPIRED}{" "}
                <a href={supportMailto(`Plan move ${o.id}`)} className="text-primary underline underline-offset-2">
                  Contact support
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
                  Accept
                </Button>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
