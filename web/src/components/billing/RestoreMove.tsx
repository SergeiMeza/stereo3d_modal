"use client";

/**
 * Restore Purchases, step 2: "Find purchases under another email" (gateway
 * 00152). This account's own sign-ins and emails are tried first, then an
 * email and its code. Each plan found says what moves and what stays;
 * Confirm moves it (Confirm it's you after an old sign-in). A plan
 * restored on another account offers to sign in to that one.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { JSX } from "react";

import { CodeInput } from "@/components/auth/CodeInput";
import { providersWords } from "@/components/auth/identityState";
import { supportMailto } from "@/components/billing/BillingBanner";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RestoreOffer } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { billingUidAtom } from "@/lib/billing";
import { CODE_LENGTH } from "@/lib/emailCode";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

import { longDate } from "./PlanCard";
import {
  CODE_SENT,
  EMPTY_RESTORE_MOVE,
  findByEmailAtom,
  findOwnAtom,
  moveOfferAtom,
  NOT_FOUND,
  RESTORED,
  restartRestoreMoveAtom,
  restoreMoveAtom,
  verifyEmailCodeAtom,
} from "./restoreMoveAtoms";

export const MOVES: Record<string, string> = {
  plan: "Your plan, until that date",
  app_access: "Pro in the app",
  current_usage: "This month's unused usage",
  months_not_yet_given: "The months of usage still to come",
};

export const STAYS: Record<string, string> = {
  usage_already_used: "Usage already used",
  balance: "The old account's balance",
  app_store_purchases: "App Store purchases",
  past_runs_and_files: "Past videos and files",
  admin_grants: "Anything support gave the old account",
};

export function planName(plan: string): string {
  if (plan === "studio") return "Studio";
  if (plan === "business") return "Business";
  return "Pro";
}

export function RestoreMove(): JSX.Element {
  const gateway = useGateway();
  const router = useRouter();
  const { signOutUser } = useAuth();
  const uid = useAppAtomValue(billingUidAtom);
  const raw = useAppAtomValue(restoreMoveAtom);
  const s = raw.uid === uid ? raw : EMPTY_RESTORE_MOVE;
  const findOwn = useAppSetAtom(findOwnAtom);
  const findByEmail = useAppSetAtom(findByEmailAtom);
  const verify = useAppSetAtom(verifyEmailCodeAtom);
  const move = useAppSetAtom(moveOfferAtom);
  const restart = useAppSetAtom(restartRestoreMoveAtom);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");

  return (
    <div data-testid="restore-move" className="flex flex-col gap-2 border-t border-edge pt-3">
      {s.phase === "idle" || s.phase === "checking" ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          disabled={s.busy || uid === null}
          onClick={() => void findOwn(gateway)}
        >
          {s.busy ? "Looking…" : "Find purchases under another email"}
        </Button>
      ) : null}

      {s.phase === "email" ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.includes("@")) void findByEmail({ client: gateway, email });
          }}
        >
          <Label htmlFor="restore-email">The email you bought it with</Label>
          <div className="flex gap-2">
            <Input id="restore-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="flex-1" />
            <Button type="submit" size="sm" disabled={s.busy || !email.includes("@")}>
              {s.busy ? "Sending…" : "Send code"}
            </Button>
          </div>
        </form>
      ) : null}

      {s.phase === "code" ? (
        <div className="flex flex-col gap-2">
          <p data-testid="restore-code-sent" className="text-sm text-fg-muted">
            {CODE_SENT} to {s.email}.
          </p>
          <CodeInput
            value={code}
            onChange={setCode}
            onComplete={(d) => void verify({ client: gateway, code: d })}
            disabled={s.busy}
            invalid={s.error !== null}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={s.busy || code.length !== CODE_LENGTH} onClick={() => void verify({ client: gateway, code })}>
              {s.busy ? "Checking…" : "Find purchases"}
            </Button>
            <Button size="sm" variant="ghost" disabled={s.busy} onClick={() => restart()}>
              Use another email
            </Button>
          </div>
        </div>
      ) : null}

      {s.phase === "offers" ? (
        <ul data-testid="restore-offers" className="flex flex-col gap-2">
          {s.offers.map((o) => (
            <OfferCard key={o.offer_id} offer={o} busy={s.busy} onConfirm={() => void move({ client: gateway, offerId: o.offer_id })} />
          ))}
        </ul>
      ) : null}

      <div role="status" aria-live="polite" className="text-sm">
        {s.phase === "restored" ? <p data-testid="restore-move-done" className="text-fg">{RESTORED}</p> : null}
        {s.phase === "none" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p data-testid="restore-move-none" className="text-fg">{NOT_FOUND}</p>
            <Button size="sm" variant="ghost" onClick={() => restart()}>
              Try another email
            </Button>
          </div>
        ) : null}
      </div>
      {s.error !== null ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-300">
          <span>
            {s.error}
            {s.elsewhere && s.elsewhere.length > 0 ? ` (It signs in with ${providersWords(s.elsewhere)}.)` : ""}
          </span>
          {s.ownPlan ? (
            <a href={supportMailto("Move a plan to my account")} className="text-primary underline underline-offset-2">
              Contact support
            </a>
          ) : null}
          {s.elsewhere !== null ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void signOutUser().then(() => router.push("/signin?next=%2Faccount%2Fbilling"));
              }}
            >
              Sign in to that account
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function OfferCard({ offer: o, busy, onConfirm }: { offer: RestoreOffer; busy: boolean; onConfirm: () => void }): JSX.Element {
  const carry = (o.carry_cents ?? 0) > 0 ? ` (${formatCents(o.carry_cents!)})` : "";
  return (
    <li data-testid={`restore-offer-${o.offer_id}`} className="flex flex-col gap-2 rounded-lg border border-edge p-3 text-sm">
      <p className="font-medium text-fg">
        {/* a cancelled plan that runs to its end (renews: false) */}
        {planName(o.plan)} plan · valid until {longDate(o.ends_at)}
      </p>
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
      <Button size="sm" className="self-start" disabled={busy} onClick={onConfirm}>
        {busy ? "Restoring…" : `Restore ${planName(o.plan)} here`}
      </Button>
    </li>
  );
}
