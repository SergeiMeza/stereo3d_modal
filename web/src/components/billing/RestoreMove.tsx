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
import { useT } from "@/lib/i18n/I18nProvider";
import type { Tr } from "@/lib/i18n/t";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

import { longDate } from "./PlanCard";
import {
  CHECK_FAILED,
  EMPTY_RESTORE_MOVE,
  findByEmailAtom,
  findOwnAtom,
  HAS_OWN_PLAN,
  moveOfferAtom,
  restartRestoreMoveAtom,
  restoreMoveAtom,
  verifyEmailCodeAtom,
} from "./restoreMoveAtoms";

/** What moves and what stays (the gateway's ids) → their messages. */
export const MOVES: Record<string, string> = {
  plan: "billing.restoreMove.moves.plan",
  app_access: "billing.restoreMove.moves.appAccess",
  current_usage: "billing.restoreMove.moves.currentUsage",
  months_not_yet_given: "billing.restoreMove.moves.monthsNotYetGiven",
};

export const STAYS: Record<string, string> = {
  usage_already_used: "billing.restoreMove.staysItems.usageAlreadyUsed",
  balance: "billing.restoreMove.staysItems.balance",
  app_store_purchases: "billing.restoreMove.staysItems.appStorePurchases",
  past_runs_and_files: "billing.restoreMove.staysItems.pastRunsAndFiles",
  admin_grants: "billing.restoreMove.staysItems.adminGrants",
};

/** The atom's English lines in the page's language (a refusal's own words stay). */
function errorText(error: string, t: Tr): string {
  if (error === HAS_OWN_PLAN) return t("billing.restoreMove.hasOwnPlan");
  if (error === CHECK_FAILED) return t("billing.restoreMove.checkFailed");
  return error;
}

export function planName(plan: string): string {
  if (plan === "studio") return "Studio";
  if (plan === "business") return "Business";
  return "Pro";
}

export function RestoreMove(): JSX.Element {
  const t = useT();
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
          {s.busy ? t("billing.restoreMove.looking") : t("billing.restoreMove.findOther")}
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
          <Label htmlFor="restore-email">{t("billing.restoreMove.emailLabel")}</Label>
          <div className="flex gap-2">
            <Input id="restore-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="flex-1" />
            <Button type="submit" size="sm" disabled={s.busy || !email.includes("@")}>
              {s.busy ? t("billing.restoreMove.sending") : t("billing.restoreMove.sendCode")}
            </Button>
          </div>
        </form>
      ) : null}

      {s.phase === "code" ? (
        <div className="flex flex-col gap-2">
          <p data-testid="restore-code-sent" className="text-sm text-fg-muted">
            {t("billing.restoreMove.codeSent", { email: s.email ?? "" })}
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
              {s.busy ? t("billing.restoreMove.checking") : t("billing.restoreMove.findPurchases")}
            </Button>
            <Button size="sm" variant="ghost" disabled={s.busy} onClick={() => restart()}>
              {t("billing.restoreMove.useAnother")}
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
        {s.phase === "restored" ? <p data-testid="restore-move-done" className="text-fg">{t("billing.restoreMove.restored")}</p> : null}
        {s.phase === "none" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p data-testid="restore-move-none" className="text-fg">{t("billing.restoreMove.notFound")}</p>
            <Button size="sm" variant="ghost" onClick={() => restart()}>
              {t("billing.restoreMove.tryAnother")}
            </Button>
          </div>
        ) : null}
      </div>
      {s.error !== null ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-300">
          <span>
            {errorText(s.error, t)}
            {s.elsewhere && s.elsewhere.length > 0 ? ` ${t("billing.restoreMove.signsInWith", { providers: providersWords(s.elsewhere, t) })}` : ""}
          </span>
          {s.ownPlan ? (
            <a href={supportMailto(t("billing.restoreMove.supportSubject"), t)} className="text-primary underline underline-offset-2">
              {t("billing.restoreMove.contactSupport")}
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
              {t("billing.restoreMove.signInThere")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function OfferCard({ offer: o, busy, onConfirm }: { offer: RestoreOffer; busy: boolean; onConfirm: () => void }): JSX.Element {
  const t = useT();
  const carry = (o.carry_cents ?? 0) > 0 ? ` (${formatCents(o.carry_cents!, t)})` : "";
  const line = (keys: Record<string, string>, m: string) => (keys[m] ? t(keys[m], { pro: "Pro" }) : m);
  return (
    <li data-testid={`restore-offer-${o.offer_id}`} className="flex flex-col gap-2 rounded-lg border border-edge p-3 text-sm">
      <p className="font-medium text-fg">
        {/* a cancelled plan that runs to its end (renews: false) */}
        {t("billing.restoreMove.offerTitle", { plan: planName(o.plan), date: longDate(o.ends_at, t) })}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <p className="text-xs text-fg-muted">{t("billing.restoreMove.movesHere")}</p>
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
          <p className="text-xs text-fg-muted">{t("billing.restoreMove.stays")}</p>
          <ul className="list-disc pl-4 text-fg-muted">
            {o.stays.map((m) => (
              <li key={m}>{line(STAYS, m)}</li>
            ))}
          </ul>
        </div>
      </div>
      <Button size="sm" className="self-start" disabled={busy} onClick={onConfirm}>
        {busy ? t("billing.restoreMove.restoring") : t("billing.restoreMove.restoreHere", { plan: planName(o.plan) })}
      </Button>
    </li>
  );
}
