"use client";

/**
 * Refunds on Billing (owner 2026-11-06; quieter since 2026-11-07): a muted
 * line at the bottom with "Request a refund" (RefundSheet), the account's
 * requests with their status in plain words and a reply when we asked a
 * question (or a follow-up on a closed one), and a notice at the top only
 * while a question waits. Each row's menu asks about its own payment. App
 * Store Pro is refunded by Apple: "Ask Apple for a refund".
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { supportMailto } from "@/components/billing/BillingBanner";
import { proCase } from "@/components/business/BusinessSetup";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { SupportRequest } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { billingUidAtom } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import { rich } from "@/lib/i18n/rich";
import { SITE_NAME } from "@/lib/site";
import { useProStatus } from "@/lib/pro/usePro";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

import {
  loadRefundOptionsAtom,
  loadSupportRequestsAtom,
  NOTE_MAX,
  openRefundSheetAtom,
  refundOptionsAtom,
  replyToRequestAtom,
  supportRequestsAtom,
} from "./refundAtoms";
import { RefundSheet, shortDay } from "./RefundSheet";

export const APPLE_REFUND_URL = "https://reportaproblem.apple.com";

/** Owner 2026-11-07: the ways in to a refund request are hidden for now —
 * the lines at the bottom of Billing (Need a refund?, the 30-day sentence,
 * Ask Apple for a refund) and each charge's "Request a refund" menu item;
 * "Report a problem" stands in. Flip to bring them all back together.
 * Your requests, the question notice and the sheet stay. */
export const SHOW_REFUND_ENTRY = false;

/** English (tests); the link reads refunds.section.reportSubject. */
export const REPORT_PROBLEM_SUBJECT = `${SITE_NAME}: report a problem`;

/** What a request is about → its message. */
const ABOUT: Record<SupportRequest["about"], string> = {
  plan: "refunds.section.about.plan",
  runs: "refunds.section.about.runs",
  balance: "refunds.section.about.balance",
  other: "refunds.section.about.other",
};

/** Loads what can be refunded and the account's requests (ADR 0138: the
 * shared atoms, also read by each Billing row's menu). */
function useRefundData() {
  const gateway = useGateway();
  const uid = useAppAtomValue(billingUidAtom);
  const options = useAppAtomValue(refundOptionsAtom);
  const requests = useAppAtomValue(supportRequestsAtom);
  const loadOptions = useAppSetAtom(loadRefundOptionsAtom);
  const loadRequests = useAppSetAtom(loadSupportRequestsAtom);
  useEffect(() => {
    if (uid === null) return;
    void loadOptions(gateway);
    void loadRequests(gateway);
  }, [uid, gateway, loadOptions, loadRequests]);
  return {
    opts: options.uid === uid ? options.data : null,
    list: requests.uid === uid ? requests.data : null,
  };
}

/** Owner 2026-11-07: the only refund line above the fold — we asked a
 * question about a request and it needs the customer's answer. */
export function RefundQuestionNotice(): JSX.Element | null {
  const t = useT();
  const uid = useAppAtomValue(billingUidAtom);
  const requests = useAppAtomValue(supportRequestsAtom);
  const list = requests.uid === uid ? requests.data : null;
  const asked = list?.find((r) => r.state === "asked");
  if (!asked) return null;
  return (
    <p data-testid="refund-question-notice" role="status" className="text-sm text-amber-200">
      {rich(t, "refunds.section.questionNotice", {
        link: (c) => (
          <a
            href={`#request-${asked.id}`}
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(`request-${asked.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {c}
          </a>
        ),
      })}
    </p>
  );
}

/** Billing's bottom (owner 2026-11-07): refunds, quietly — one muted line
 * with a text link, the App Store line, and Your requests when there are
 * any. The sheet stays mounted here. */
export function RefundsFooter(): JSX.Element {
  const t = useT();
  const { opts, list } = useRefundData();
  const openSheet = useAppSetAtom(openRefundSheetAtom);
  const pro = useProStatus();
  const plan = opts?.plan ?? null;
  const askable = (plan !== null && plan.open_request_id === null) || (opts?.runs ?? []).some((r) => r.open_request_id === null);
  const appStore = proCase(pro) === "app_store";
  const days = opts?.window_days ?? 30;

  return (
    <footer data-testid="refunds" aria-label={t("refunds.section.ariaLabel")} className="flex flex-col gap-3 text-xs text-fg-muted">
      {/* owner 2026-11-07: one generic contact point in place of the
          refund lines while SHOW_REFUND_ENTRY is off */}
      {SHOW_REFUND_ENTRY ? null : (
        <p data-testid="report-problem">
          {rich(t, "refunds.section.reportProblem", {
            link: (c) => (
              <a
                href={supportMailto(REPORT_PROBLEM_SUBJECT, t)}
                className="text-primary underline underline-offset-2 hover:text-primary/80"
              >
                {c}
              </a>
            ),
          })}
        </p>
      )}
      {SHOW_REFUND_ENTRY ? (
      <p data-testid="refunds-line">
        {askable
          ? rich(
              t,
              "refunds.section.needRefund",
              {
                button: (c) => (
                  <button
                    type="button"
                    data-testid="refunds-request"
                    onClick={() => openSheet()}
                    className="text-primary underline underline-offset-2 hover:text-primary/80"
                  >
                    {c}
                  </button>
                ),
              },
              { days },
            )
          : t("refunds.section.askWithin", { days })}
      </p>
      ) : null}
      {SHOW_REFUND_ENTRY && appStore ? (
        <p data-testid="refund-app-store">
          {rich(
            t,
            "refunds.section.appStore",
            {
              link: (c) => (
                <a href={APPLE_REFUND_URL} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                  {c}
                </a>
              ),
            },
            { pro: "Pro" },
          )}
        </p>
      ) : null}
      {list !== null && list.length > 0 ? (
        <div className="flex flex-col gap-2 text-sm">
          <h2 className="text-xs font-medium text-fg-muted">{t("refunds.section.yourRequests")}</h2>
          <ul data-testid="support-requests" className="divide-y divide-edge rounded-lg border border-edge bg-surface-1">
            {list.map((r) => (
              <RequestRow key={r.id} request={r} />
            ))}
          </ul>
        </div>
      ) : null}
      <RefundSheet />
    </footer>
  );
}

function RequestRow({ request: r }: { request: SupportRequest }): JSX.Element {
  const t = useT();
  const gateway = useGateway();
  const reply = useAppSetAtom(replyToRequestAtom);
  const asked = r.state === "asked";
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = r.state === "refunded" || r.state === "not_refunded" || r.state === "waived" || r.state === "closed";

  async function send(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await reply({ client: gateway, id: r.id, text });
      setText("");
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("refunds.section.replyFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li id={`request-${r.id}`} data-testid={`request-${r.id}`} className="flex scroll-mt-24 flex-col gap-2 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-fg">{t(ABOUT[r.about] ?? ABOUT.other)}</span>
        <span className="text-xs text-fg-muted">{shortDay(r.opened_at, t)}</span>
        {typeof r.requested_cents === "number" && r.requested_cents > 0 ? (
          <span className="text-xs text-fg-muted tabular-nums">{formatCents(r.requested_cents, t)}</span>
        ) : null}
        <span data-testid="request-status" className={`ms-auto text-xs ${asked ? "text-amber-300" : "text-fg"}`}>
          {r.status}
          {r.state === "refunded" && (r.refunded_cents ?? 0) > 0 ? ` · ${formatCents(r.refunded_cents!, t)}` : ""}
        </span>
      </div>
      {asked && r.question ? (
        <p data-testid="request-question" className="rounded-md bg-surface-2 px-3 py-2 text-fg">
          {r.question}
        </p>
      ) : null}
      {open || asked ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={asked ? t("refunds.section.answerLabel") : t("refunds.section.messageLabel")}
            value={text}
            maxLength={NOTE_MAX}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-primary/60"
          />
          {error !== null && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>
              {busy ? t("refunds.section.sending") : asked ? t("refunds.section.sendAnswer") : t("refunds.section.send")}
            </Button>
            {!asked ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
                {t("refunds.section.cancel")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="self-start text-xs text-primary hover:underline">
          {done ? t("refunds.section.askAgain") : t("refunds.section.addMessage")}
        </button>
      )}
    </li>
  );
}
