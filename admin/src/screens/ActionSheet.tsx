import { useMemo, useState } from "react";

import { Banner, ExtLink, Modal, Note } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, FieldControl, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ApiError, errorMessage } from "../lib/api";
import { centsToInput, money, parseDollars } from "../lib/format";
import { useServices } from "../lib/services";
import type {
  CaseAction,
  CaseActionBody,
  CasePage,
  MailPreview,
  MailPreviewsResponse,
  RunRow,
} from "../lib/types";

/** Actions that move money (or close one off); they get the full confirm sheet. */
export const MONEY_ACTIONS: CaseAction[] = [
  "approve",
  "partial",
  "waive",
  "deny",
  "no_refund",
  "mark_out_of_band",
  "assign",
  "stop_run",
];

const DENY_TEMPLATES: { id: "delivered" | "outside_terms" | "other"; label: string }[] = [
  { id: "delivered", label: "Delivered as described" },
  { id: "outside_terms", label: "Outside our refund terms" },
  { id: "other", label: "Other (write the text)" },
];

export function runs(page: CasePage): RunRow[] {
  return page.runs ?? [];
}

export function isBalanceCase(page: CasePage): boolean {
  return page.case.type === "balance_refund";
}

/** Amount each run would get on Approve: its refundable now. */
export function approveItems(page: CasePage): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of runs(page)) if (r.refundable_cents > 0) out[r.conversion_id] = r.refundable_cents;
  return out;
}

export function owedTotal(page: CasePage): number {
  return runs(page).reduce((s, r) => s + (r.owed_cents ?? 0), 0);
}

/**
 * "Pro rata of failed parts": price × failed parts ÷ parts, from the latest
 * evidence (parts count and files delivered). Only for split runs.
 */
export function proRata(page: CasePage): Record<string, number> | null {
  const ev = page.evidence?.runs ?? [];
  const out: Record<string, number> = {};
  let any = false;
  for (const r of runs(page)) {
    const e = ev.find((x) => x.conversion_id === r.conversion_id);
    const parts = e?.parts ?? 0;
    if (parts <= 0) continue;
    const delivered = Math.min(e?.files_delivered?.length ?? 0, parts);
    const failed = parts - delivered;
    out[r.conversion_id] = Math.min(Math.round((r.price_cents * failed) / parts), r.refundable_cents);
    any = true;
  }
  return any ? out : null;
}

function allFromBalance(page: CasePage): boolean {
  const rs = runs(page);
  return rs.length > 0 && rs.every((r) => r.paid_from === "balance");
}

/** Fills the gateway's sample mail with this case's id and amount. */
function fillMail(m: MailPreview, caseId: string, cents: number | null): MailPreview {
  const fill = (s: string) => {
    let out = s.replace(/CASE-\d{4,}/g, caseId);
    if (cents !== null) out = out.replace(/\$\d[\d,]*\.\d{2}/g, money(cents));
    return out;
  };
  return { id: m.id, subject: fill(m.subject), text: fill(m.text) };
}

interface MailPlan {
  mail: MailPreview | null;
  note: string;
}

function mailPlan(
  action: CaseAction,
  page: CasePage,
  previews: MailPreviewsResponse | null,
  cents: number,
  template: string,
  text: string,
): MailPlan {
  const c = page.case;
  const find = (id: string) => previews?.mails?.find((m) => m.id === id) ?? null;
  const none = (note: string): MailPlan => ({ mail: null, note });
  switch (action) {
    case "approve":
    case "partial":
    case "mark_out_of_band": {
      const base = find(allFromBalance(page) && action !== "mark_out_of_band" ? "E6 balance" : "E6");
      return base
        ? { mail: fillMail(base, c.id, cents), note: "Sent once the refund succeeds." }
        : none("Mail E6 is sent once the refund succeeds.");
    }
    case "waive": {
      if (!c.customer_visible) return none("No mail: this case isn't customer-visible.");
      const base = find("E6 waive");
      return base ? { mail: fillMail(base, c.id, cents), note: "" } : none("Mail E6 (waive).");
    }
    case "deny": {
      if (!c.customer_visible) return none("No mail: this case isn't customer-visible.");
      const base = find("E10");
      const body = template === "other" ? text.trim() : previews?.deny_templates?.[template] ?? "";
      const mail = base
        ? {
            id: "E10",
            subject: fillMail(base, c.id, null).subject,
            text: `${body}\n\nQuestions? Reply to this email and quote ${c.id}.`,
          }
        : null;
      return { mail, note: "" };
    }
    case "ask": {
      const base = find("E11");
      const mail = base
        ? {
            id: "E11",
            subject: fillMail(base, c.id, null).subject,
            text: `${text.trim()}\n\nReply to this email. Your case: ${c.id}.`,
          }
        : null;
      return { mail, note: "The case waits on the customer until you paste their reply." };
    }
    case "no_refund":
      return none("Closes the case without a mail.");
    default:
      return none("");
  }
}

function MailBox({ plan }: { plan: MailPlan }) {
  if (!plan.mail) return plan.note ? <Note>{plan.note}</Note> : null;
  return (
    <>
      <details className="rounded-lg bg-[#101014] ring-1 ring-border ring-inset">
        <summary className="cursor-pointer px-3 py-2.5 text-[12.5px]">
          Mail {plan.mail.id} · {plan.mail.subject}
        </summary>
        <pre className="m-0 px-3 pb-3 font-sans text-sm whitespace-pre-wrap text-foreground-2 [overflow-wrap:anywhere]">{plan.mail.text}</pre>
      </details>
      {plan.note && <Note>{plan.note}</Note>}
    </>
  );
}

function stripeDisputeUrl(page: CasePage): string | null {
  return page.evidence?.links?.stripe_urls?.find((u) => u.includes("/disputes/")) ?? null;
}

/**
 * The confirm sheet for one case action: amount per run, what's left after
 * it, and the mail that goes out. 409 amount_changed reloads the page and
 * asks for a fresh confirm; 401 reauth_required asks for a fresh sign-in.
 */
export function ActionSheet({
  action,
  page,
  previews,
  onClose,
  onDone,
  onReload,
}: {
  action: CaseAction;
  page: CasePage;
  previews: MailPreviewsResponse | null;
  onClose: () => void;
  onDone: (page: CasePage) => void;
  onReload: () => Promise<CasePage>;
}) {
  const { api, withReauth } = useServices();
  const c = page.case;
  const rs = runs(page);
  const max = page.max_refundable_cents;
  const balance = isBalanceCase(page);

  const unassigned = (page.refunds ?? []).find((r) => r.case_id === c.id && r.source === "dashboard");
  const editable = action === "partial" || action === "mark_out_of_band" || action === "assign";
  const initial = useMemo(() => {
    const v: Record<string, string> = {};
    if (balance) v.balance = centsToInput(action === "partial" ? 0 : max);
    for (const r of rs) {
      const cents = action === "assign" ? 0 : action === "partial" ? 0 : r.refundable_cents;
      v[r.conversion_id] = centsToInput(cents);
    }
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);
  const [inputs, setInputs] = useState(initial);
  const [template, setTemplate] = useState<"delivered" | "outside_terms" | "other">("delivered");
  const [text, setText] = useState("");
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState<number | null>(null);

  // Cents per run for this action.
  const items: Record<string, number> = useMemo(() => {
    if (action === "approve") return balance ? { balance: max } : approveItems(page);
    if (action === "waive") {
      const o: Record<string, number> = {};
      for (const r of rs) if (r.owed_cents) o[r.conversion_id] = r.owed_cents;
      return o;
    }
    if (!editable) return {};
    const o: Record<string, number> = {};
    for (const [k, v] of Object.entries(inputs)) {
      const cents = parseDollars(v);
      if (cents) o[k] = cents;
    }
    return o;
  }, [action, balance, max, page, rs, editable, inputs]);
  const total = Object.values(items).reduce((s, v) => s + v, 0);

  // Per-run limits.
  const limitOf = (id: string) =>
    id === "balance" ? max : rs.find((r) => r.conversion_id === id)?.refundable_cents ?? 0;
  const invalid: string[] = [];
  if (editable) {
    for (const [k, v] of Object.entries(inputs)) {
      const cents = parseDollars(v);
      if (cents === null && v.trim() !== "") invalid.push(k);
      else if (cents !== null && action !== "assign" && cents > limitOf(k)) invalid.push(k);
    }
  }

  let blocker = "";
  if (invalid.length) blocker = "Each amount must be at most that run's refundable amount.";
  else if ((action === "partial" || action === "mark_out_of_band") && total <= 0) blocker = "Enter an amount.";
  else if (action === "approve" && total <= 0) blocker = "Nothing is refundable on this case.";
  else if (action === "assign" && unassigned && total !== unassigned.total_cents)
    blocker = `The amounts must add up to ${money(unassigned.total_cents)}.`;
  else if (action === "deny" && template === "other" && !text.trim()) blocker = "Write the text.";
  else if ((action === "ask" || action === "customer_reply") && !text.trim()) blocker = "Write the text.";
  else if (action === "mark_out_of_band" && (!method.trim() || !reference.trim()))
    blocker = "Give the method and a reference.";

  const methodLabel = page.account.payment_method || "the payment method";
  const toBalance = allFromBalance(page);
  const title = (() => {
    switch (action) {
      case "approve":
      case "partial":
        return balance
          ? `Refund ${money(total)} of the balance`
          : toBalance
            ? `Return ${money(total)} to the balance`
            : `Refund ${money(total)} to ${methodLabel}`;
      case "waive":
        return `Waive ${money(total)}`;
      case "deny":
        return "Deny refund";
      case "no_refund":
        return "No refund";
      case "ask":
        return "Ask the customer";
      case "customer_reply":
        return "Add the customer's reply";
      case "mark_out_of_band":
        return `Mark ${money(total)} refunded outside Stripe`;
      case "assign":
        return "Assign the Dashboard refund";
      case "stop_run":
        return "Stop the run now";
      case "accept_dispute":
        return "Record: accept the dispute";
      case "counter_dispute":
        return "Record: counter the dispute";
      case "counter_with_refund_proof":
        return "Record: counter with the refund proof";
      case "close":
        return `Close ${c.id}`;
      default:
        return action;
    }
  })();

  const subtitle = (() => {
    const bits = [c.id];
    if (action === "approve") bits.push("full");
    if (action === "partial") bits.push("partial");
    if (action === "waive") bits.push("no charge, no invoice line");
    if (action === "stop_run") bits.push("cancelled as ours, refunded in full by its own path");
    if (action.endsWith("dispute") || action === "counter_with_refund_proof")
      bits.push("do it in the Stripe Dashboard; this records the decision");
    return bits.join(" · ");
  })();

  const plan = mailPlan(action, page, previews, total, template, text);
  const showsBreakdown = ["approve", "partial", "waive", "mark_out_of_band", "assign"].includes(action);
  const remaining =
    action === "waive"
      ? Math.max(0, owedTotal(page) - total)
      : Math.max(0, (balance ? max : rs.reduce((s, r) => s + r.refundable_cents, 0)) - total);

  const body = (): CaseActionBody => {
    switch (action) {
      case "approve":
        return { action, expected_max_cents: max };
      case "partial":
        return { action, items, expected_max_cents: max };
      case "mark_out_of_band":
        return { action, items, method: method.trim(), reference: reference.trim() };
      case "assign":
        return { action, items };
      case "deny":
        return { action, template, text: template === "other" ? text.trim() : undefined };
      case "ask":
      case "customer_reply":
        return { action, text: text.trim() };
      case "close":
        return { action, text: text.trim() || undefined };
      default:
        return { action, text: text.trim() || undefined };
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await withReauth(() => api.caseAction(c.id, body()));
      onDone(next);
    } catch (err) {
      if (err instanceof ApiError && err.code === "amount_changed") {
        const fresh = await onReload().catch(() => null);
        const now =
          typeof err.details?.max_refundable_cents === "number"
            ? (err.details.max_refundable_cents as number)
            : fresh?.max_refundable_cents ?? null;
        setChanged(now);
        if (fresh && editable) {
          // Clamp what was typed to the new per-run maximum.
          setInputs((cur) => {
            const o = { ...cur };
            for (const r of fresh.runs ?? []) {
              const v = parseDollars(o[r.conversion_id] ?? "") ?? 0;
              if (v > r.refundable_cents) o[r.conversion_id] = centsToInput(r.refundable_cents);
            }
            return o;
          });
        }
      } else if (err instanceof ApiError && err.code === "case_closed") {
        setError("Reopen the case to add notes or decisions.");
        void onReload().catch(() => {});
      } else if (err instanceof ApiError && err.code === "action_unavailable") {
        setError("That action isn't available on this case now. The page has been reloaded.");
        void onReload().catch(() => {});
      } else {
        const msg = errorMessage(err);
        const isMoney = MONEY_ACTIONS.includes(action);
        setError(
          msg.startsWith("That didn't work") || msg.startsWith("Not confirmed")
            ? msg
            : `That didn't work: ${msg.replace(/\.$/, "")}.${isMoney ? " Nothing was charged or refunded." : ""}`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const rp = proRata(page);
  const disputeUrl = stripeDisputeUrl(page);

  const kind = MONEY_ACTIONS.includes(action) ? "alert" : action === "ask" || action === "customer_reply" ? "sheet" : "dialog";
  const numCls = "py-1.5 text-right font-mono tabular-nums";

  return (
    <Modal
      kind={kind}
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      busy={busy}
      wide={editable}
      confirmLabel={busy ? "Working…" : "Confirm"}
      onConfirm={() => void confirm()}
      confirmDisabled={!!blocker}
    >
      {changed !== null && (
        <Banner tone="amber">The amount changed to {money(changed)}. Check it and confirm again.</Banner>
      )}

      {showsBreakdown && (
        <table className="w-full border-collapse text-[12.5px] [&_td]:border-b [&_td]:border-[#1c1c21] [&_td]:pr-2 [&_td]:text-foreground-2 [&_th]:border-b [&_th]:border-border [&_th]:py-1.5 [&_th]:pr-2 [&_th]:text-2xs [&_th]:font-medium [&_th]:text-muted-foreground">
          <thead>
            <tr>
              <th className="text-left">Run</th>
              {editable && <th className="text-right">Up to</th>}
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {balance && (action === "approve" || action === "partial") ? (
              <tr>
                <td className="py-1.5">Unspent cash balance</td>
                {editable && <td className={numCls}>{money(max)}</td>}
                <td className={numCls}>
                  {editable ? (
                    <AmountInput id="balance" value={inputs.balance ?? ""} bad={invalid.includes("balance")} onChange={(v) => setInputs((s) => ({ ...s, balance: v }))} />
                  ) : (
                    <b className="text-foreground">{money(total)}</b>
                  )}
                </td>
              </tr>
            ) : (
              rs
                .filter((r) => editable || items[r.conversion_id])
                .map((r) => (
                  <tr key={r.conversion_id}>
                    <td className="py-1.5">
                      <span className="font-mono text-xs text-muted-foreground">{r.conversion_id}</span> {r.label}
                    </td>
                    {editable && <td className={numCls}>{money(action === "assign" ? r.price_cents : r.refundable_cents)}</td>}
                    <td className={numCls}>
                      {editable ? (
                        <AmountInput
                          id={r.conversion_id}
                          value={inputs[r.conversion_id] ?? ""}
                          bad={invalid.includes(r.conversion_id)}
                          onChange={(v) => setInputs((s) => ({ ...s, [r.conversion_id]: v }))}
                        />
                      ) : (
                        <b className="text-foreground">{money(items[r.conversion_id] ?? 0)}</b>
                      )}
                    </td>
                  </tr>
                ))
            )}
          </tbody>
        </table>
      )}

      {action === "partial" && rp && !balance && (
        <div>
          <Button
            size="xs"
            onClick={() =>
              setInputs((s) => {
                const o = { ...s };
                for (const [k, v] of Object.entries(rp)) o[k] = centsToInput(v);
                return o;
              })
            }
          >
            Pro rata of failed parts
          </Button>
        </div>
      )}

      {showsBreakdown && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm text-muted-foreground [&_dd]:text-right [&_dd]:font-mono [&_dd]:text-foreground [&_dd]:tabular-nums">
          <dt>Total</dt>
          <dd>{money(total)}</dd>
          {action !== "assign" && (
            <>
              <dt>{action === "waive" ? "Owed after this" : "Refundable after this"}</dt>
              <dd>{money(remaining)}</dd>
            </>
          )}
          {action === "assign" && unassigned && (
            <>
              <dt>Dashboard refund</dt>
              <dd>{money(unassigned.total_cents)}</dd>
            </>
          )}
        </dl>
      )}

      {action === "deny" && (
        <FieldSet>
          <FieldLegend>Template</FieldLegend>
          <RadioGroup value={template} onValueChange={(v) => setTemplate(v as typeof template)} aria-label="Template">
            {DENY_TEMPLATES.map((t) => (
              <div key={t.id} className="flex items-center gap-2">
                <RadioGroupItem value={t.id} id={`tpl-${t.id}`} />
                <Label htmlFor={`tpl-${t.id}`} className="text-sm text-foreground">{t.label}</Label>
              </div>
            ))}
          </RadioGroup>
          {template === "other" && (
            <Textarea rows={4} aria-label="Text for the customer" value={text} onChange={(e) => setText(e.target.value)} />
          )}
        </FieldSet>
      )}

      {action === "ask" && (
        <Field>
          <FieldLabel>Question for the customer (mail E11)</FieldLabel>
          <FieldControl>
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </FieldControl>
        </Field>
      )}
      {action === "customer_reply" && (
        <Field>
          <FieldLabel>Paste the customer's message</FieldLabel>
          <FieldControl>
            <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
          </FieldControl>
          <FieldDescription>Kept as plain text. A case waiting on the customer opens again.</FieldDescription>
        </Field>
      )}
      {action === "mark_out_of_band" && (
        <div className="flex gap-2 max-sm:flex-col">
          <Field>
            <FieldLabel>Method</FieldLabel>
            <FieldControl>
              <Input placeholder="Bank transfer, PayPal…" value={method} onChange={(e) => setMethod(e.target.value)} />
            </FieldControl>
          </Field>
          <Field>
            <FieldLabel>Reference</FieldLabel>
            <FieldControl>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </FieldControl>
          </Field>
        </div>
      )}
      {action === "close" && (
        <Field>
          <FieldLabel>
            {c.decision || c.status === "decided" ? "Note (optional)" : "Why close it undecided (e.g. a duplicate of CASE-0040)"}
          </FieldLabel>
          <FieldControl>
            <Input value={text} onChange={(e) => setText(e.target.value)} />
          </FieldControl>
        </Field>
      )}
      {(action === "accept_dispute" || action === "counter_dispute" || action === "counter_with_refund_proof") && (
        <>
          <p className="text-sm">
            {action === "accept_dispute"
              ? "Accept it in the Stripe Dashboard: the amount and the fee stay lost."
              : "Submit the evidence in the Stripe Dashboard before it's due."}
          </p>
          {disputeUrl && <ExtLink href={disputeUrl}>Open the dispute in Stripe</ExtLink>}
          <Field>
            <FieldLabel>Note (optional)</FieldLabel>
            <FieldControl>
              <Input value={text} onChange={(e) => setText(e.target.value)} />
            </FieldControl>
          </Field>
        </>
      )}
      {action === "stop_run" && (
        <p className="text-sm">Cancels the run as ours. It's refunded in full by its own path, and the case closes.</p>
      )}

      <MailBox plan={plan} />

      {blocker && !busy && (editable || action === "deny" || action === "ask" || action === "customer_reply") && (
        <Note>{blocker}</Note>
      )}
      {error && <Note tone="error">{error}</Note>}
    </Modal>
  );
}

function AmountInput({
  id,
  value,
  bad,
  onChange,
}: {
  id: string;
  value: string;
  bad: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      $
      <Input
        className={cn("w-24 text-right font-mono tabular-nums", bad && "border-destructive")}
        inputMode="decimal"
        aria-label={`Amount for ${id}`}
        aria-invalid={bad}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}
