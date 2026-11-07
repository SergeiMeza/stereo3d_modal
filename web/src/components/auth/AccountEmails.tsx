"use client";

/**
 * Account → Sign-in & security → Emails (gateway 00152): up to five, any of
 * them signs in with the email code; one is main (receipts and Restore
 * Purchases go to it). Make main, Remove, and "Add another email" with a
 * code. Every change asks "Confirm it's you" after an old sign-in.
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/authErrors";
import { billingUidAtom } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

import { AddEmailForm } from "./AddEmailForm";
import { emailsAtom, loadEmailsAtom, MAX_EMAILS, makeMainEmailAtom, removeEmailAtom } from "./emailAtoms";
import { PlanEmailPrompt } from "@/components/billing/PlanEmailPrompt";

export function AccountEmails(): JSX.Element | null {
  const t = useT();
  const gateway = useGateway();
  const { reloadUser } = useAuth();
  const uid = useAppAtomValue(billingUidAtom);
  const state = useAppAtomValue(emailsAtom);
  const load = useAppSetAtom(loadEmailsAtom);
  const makeMain = useAppSetAtom(makeMainEmailAtom);
  const remove = useAppSetAtom(removeEmailAtom);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (uid !== null) void load(gateway);
  }, [uid, gateway, load]);

  const data = state.uid === uid ? state.data : null;
  if (data === null) return null;
  const list = data.emails;

  async function run(id: string, op: () => Promise<unknown>): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await op();
    } catch (e) {
      setError(errorText(e, t, "auth.errors.didntWork"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="account-emails" className="space-y-2">
      <p className="text-xs text-fg-muted">{t("auth.emails.heading")}</p>
      {data.plan_email_needed ? <PlanEmailPrompt /> : null}
      <ul className="divide-y divide-edge rounded-lg border border-edge">
        {list.map((e) => (
          <li key={e.id} data-testid={`email-${e.email}`} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-fg">{e.email}</span>
              {e.relay ? <span className="block text-xs text-fg-muted">{t("auth.emails.hiddenApple")}</span> : null}
            </span>
            {e.main ? (
              <span className="rounded-full border border-primary/40 px-2 py-0.5 text-[11px] text-primary">{t("auth.emails.main")}</span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void run(e.id, () => makeMain({ client: gateway, id: e.id, reloadUser }))}
              >
                {busy === e.id ? t("account.profile.saving") : t("auth.emails.makeMain")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              aria-label={t("auth.emails.removeLabel", { email: e.email })}
              onClick={() => void run(e.id, () => remove({ client: gateway, id: e.id, reloadUser }))}
              className="text-fg-muted hover:text-destructive"
            >
              {t("auth.emails.remove")}
            </Button>
          </li>
        ))}
      </ul>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {adding ? (
        <AddEmailForm idPrefix="add-email" mainChoice onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
      ) : list.length < MAX_EMAILS ? (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          {t("auth.emails.addAnother")}
        </Button>
      ) : (
        <p className="text-xs text-fg-muted">{t("auth.emails.full", { count: MAX_EMAILS })}</p>
      )}
    </div>
  );
}
