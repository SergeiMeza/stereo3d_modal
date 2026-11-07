"use client";

/**
 * P15 Add payment method (spec v6.2): Billing's own form in place of the
 * portal. Same frames as P1. A setup session (POST
 * /v1/billing/methods/setup) shows only methods that can be saved; the
 * first method becomes the default by itself, later ones only when "Make
 * this my default" is ticked.
 */

import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN } from "@/lib/i18n/t";

import { CheckoutPane, type ConfirmResult } from "./CheckoutPane";
import { StateLine, Success, SUCCESS_CLOSE_MS } from "./PaySheet";
import { SheetFrame, useSheetFrame } from "./SheetFrame";

export const ADD_TITLE = EN("pay.addMethod.title");
export const SAVE_DECLINED = EN("pay.addMethod.saveDeclined");
export const SAVE_TOO_MANY = EN("pay.addMethod.saveTooMany");
export const SAVE_LIMIT = EN("pay.addMethod.saveLimit");

type Phase =
  | { kind: "loading" }
  /** notice: the error line's message key */
  | { kind: "ready"; secret: string; publishableKey?: string; notice?: string }
  | { kind: "saving"; secret: string; publishableKey?: string }
  | { kind: "done" }
  | { kind: "limit" }
  | { kind: "unavailable" };

export function AddMethodSheet({
  first,
  onClose,
}: {
  /** no method saved yet: the checkbox is hidden and implied */
  first: boolean;
  /** saved = a method was added */
  onClose: (saved: boolean) => void;
}): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  const big = useSheetFrame() === "headset";
  const [makeDefault, setMakeDefault] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    if (phase.kind !== "loading") return;
    let live = true;
    gateway.setupPaymentMethod(first || makeDefault).then(
      (s) => live && setPhase({ kind: "ready", secret: s.client_secret, publishableKey: s.publishable_key }),
      (e: { code?: string }) => {
        if (!live) return;
        setPhase(e.code === "too_many_methods" ? { kind: "limit" } : { kind: "unavailable" });
      },
    );
    return () => {
      live = false;
    };
  }, [phase.kind, gateway, first, makeDefault]);

  useEffect(() => {
    if (phase.kind !== "done") return;
    const timer = setTimeout(() => onClose(true), SUCCESS_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [phase.kind, onClose]);

  function handle(r: ConfirmResult, secret: string, publishableKey?: string): void {
    if (r === "paid" || r === "already_paid") return setPhase({ kind: "done" });
    if (r === "redirect") return;
    setPhase({
      kind: "ready",
      secret,
      publishableKey,
      notice: r === "too_many" ? "pay.addMethod.saveTooMany" : "pay.addMethod.saveDeclined",
    });
  }

  if (phase.kind === "ready" || phase.kind === "saving") {
    const { secret, publishableKey } = phase;
    const saving = phase.kind === "saving";
    const notice = phase.kind === "ready" ? phase.notice : undefined;
    return (
      <CheckoutPane clientSecret={secret} publishableKey={publishableKey} big={big} setup returnQuery="added=1">
        {(form, body) => (
          <SheetFrame
            open
            onClose={() => onClose(false)}
            locked={saving}
            testId="add-method-sheet"
            title={t("pay.addMethod.title")}
            footer={
              <div className="flex flex-col gap-3">
                {!first ? (
                  <label className={`flex items-center gap-2 text-fg ${big ? "text-xl" : "text-sm"}`}>
                    <input
                      type="checkbox"
                      checked={makeDefault}
                      disabled={saving}
                      onChange={(e) => setMakeDefault(e.target.checked)}
                      className="accent-primary"
                    />
                    {t("pay.addMethod.makeDefault")}
                  </label>
                ) : null}
                <Button
                  size="lg"
                  data-testid="add-method-save"
                  className={`w-full ${big ? "h-14 text-xl" : "h-12 text-base"}`}
                  disabled={!form.ready || saving}
                  onClick={async () => {
                    setPhase({ kind: "saving", secret, publishableKey });
                    // the default choice rides on the setup request; a
                    // late tick sets it once saved
                    const r = await form.confirm();
                    if ((r === "paid" || r === "already_paid") && makeDefault && !first) {
                      const list = await gateway.getPaymentMethods().catch(() => null);
                      const added = list?.methods.at(-1);
                      if (added && !added.is_default) await gateway.setDefaultMethod(added.id).catch(() => {});
                    }
                    handle(r, secret, publishableKey);
                  }}
                >
                  {saving ? t("pay.addMethod.saving") : t("pay.addMethod.save")}
                </Button>
              </div>
            }
          >
            <div className={`flex flex-col gap-4 ${saving ? "pointer-events-none opacity-60" : ""}`}>
              {body}
              {notice ? (
                <p data-testid="add-method-error" className="text-sm text-red-400">
                  {t(notice)}
                </p>
              ) : null}
            </div>
          </SheetFrame>
        )}
      </CheckoutPane>
    );
  }

  let body: ReactNode;
  if (phase.kind === "loading") {
    body = (
      <div data-testid="pay-skeleton" className="flex animate-pulse flex-col gap-3">
        <div className="h-12 rounded-lg bg-surface-2" />
        <div className="h-11 rounded-lg bg-surface-2" />
      </div>
    );
  } else if (phase.kind === "done") {
    body = <Success text={t("pay.addMethod.saved")} />;
  } else if (phase.kind === "limit") {
    body = <StateLine testId="add-method-limit" text={t("pay.addMethod.saveLimit")} />;
  } else {
    body = <StateLine testId="pay-unavailable" text={t("pay.copy.unavailable")} />;
  }
  return (
    <SheetFrame open onClose={() => onClose(phase.kind === "done")} testId="add-method-sheet" title={t("pay.addMethod.title")}>
      {body}
    </SheetFrame>
  );
}
