import { useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { EmptyRow, FilterSelect, Modal, Note, Panel, type Tone } from "@/components/common";
import { PasskeyNote } from "@/components/PasskeyNote";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldControl, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, errorMessage } from "../lib/api";
import { dateOnly, dateTime, money, parseDollars } from "../lib/format";
import { useServices } from "../lib/services";
import { accountQuery, allCreditGrantsQuery, creditGrantsQuery } from "@/state/queries";
import { useQuery } from "@/state/query";
import type { CreditGrant, CreditGrantPreview, CreditGrantReason } from "../lib/types";

/**
 * Grant credit (owner 2026-11-07, gateway 00178): usage credit an admin
 * adds to an account, spent before the card, never paid out. The dialog
 * takes a USD amount, a reason (Other needs words), an end (90 days by
 * default, or none), and an optional mail with an editable message; it
 * previews the balance before and after, and above the cap asks for a
 * second confirmation. Granting and revoking need a fresh sign-in. One
 * request_id per dialog, so a retry after the sign-in grants once. The
 * user sees "Credit from Spatial Video Studio", never the reason.
 */

export const CREDIT_REASONS: { id: CreditGrantReason; label: string }[] = [
  { id: "support_goodwill", label: "Support goodwill" },
  { id: "refund_as_credit", label: "Refund as credit" },
  { id: "promo", label: "Promo" },
  { id: "test", label: "Test" },
  { id: "other", label: "Other" },
];

export function reasonLabel(g: Pick<CreditGrant, "reason" | "reason_text">): string {
  const r = CREDIT_REASONS.find((x) => x.id === g.reason)?.label ?? g.reason;
  return g.reason === "other" && g.reason_text ? `Other: ${g.reason_text}` : g.reason_text ? `${r}: ${g.reason_text}` : r;
}

export const CREDIT_STATE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Granting", tone: "blue" },
  active: { label: "Active", tone: "green" },
  revoked: { label: "Revoked", tone: "amber" },
};

const MAIL: Record<string, string> = { sent: "Mailed", dry_run: "Mail dry run", skipped: "No email on file" };

export const DEFAULT_MESSAGE = "Thanks for using Spatial Video Studio. This credit is on us.";

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `cg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** An account's credit grants, with Grant credit… and Revoke unspent. */
export function CreditGrantsSection({ uid, email }: { uid: string; email?: string | null }) {
  const { state, retry, set } = useQuery(creditGrantsQuery, uid);
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<CreditGrant | null>(null);
  // the account's balance changed: reload it, and the all-grants list
  const runAccount = useSetAtom(accountQuery.run);
  const runAll = useSetAtom(allCreditGrantsQuery.run);
  const upsert = (g: CreditGrant) => {
    set((prev) => [g, ...(prev ?? []).filter((x) => x.id !== g.id)].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));
    runAccount(uid, "keep").catch(() => {});
    runAll(null, "keep").catch(() => {});
  };
  const grants = state.kind === "loaded" ? state.data : [];
  return (
    <Panel
      title="Credit grants"
      note="usage credit given by us"
      action={<Button variant="default" onClick={() => setGranting(true)}>Grant credit…</Button>}
      data-testid="credit-grants"
    >
      {state.kind === "loading" && <EmptyRow>Loading…</EmptyRow>}
      {state.kind === "error" && (
        <EmptyRow>
          Couldn't load the credit grants.{" "}
          <Button size="sm" variant="ghost" onClick={retry}>Try again</Button>
        </EmptyRow>
      )}
      {state.kind === "loaded" &&
        (grants.length === 0 ? (
          <EmptyRow>No credit granted.</EmptyRow>
        ) : (
          <Table data-testid="credit-grants-table">
            <TableHeader>
              <TableRow>
                <TableHead numeric>Amount</TableHead>
                <TableHead numeric>Unspent</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Ends</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Granted</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.map((g) => {
                const st = CREDIT_STATE[g.state] ?? { label: g.state, tone: "plain" as Tone };
                const unspent = g.unspent_cents ?? 0;
                return (
                  <TableRow key={g.id} data-testid={`credit-grant-${g.id}`}>
                    <TableCell numeric>
                      {money(g.amount_cents)}
                      {g.over_cap ? <div className="text-xs text-warning-foreground">above the cap</div> : null}
                    </TableCell>
                    <TableCell numeric>{typeof g.unspent_cents === "number" ? money(g.unspent_cents) : "—"}</TableCell>
                    <TableCell>
                      <Badge variant={st.tone}>{st.label}</Badge>
                      {g.state === "revoked" ? (
                        <div className="text-xs text-muted-foreground">
                          {money(g.revoked_cents ?? 0)} removed{g.revoked_by ? ` by ${g.revoked_by}` : ""}
                          {g.revoked_at ? ` · ${dateOnly(g.revoked_at)}` : ""}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-72 text-xs whitespace-normal">
                      {reasonLabel(g)}
                      {g.notify_user ? (
                        <div className="text-muted-foreground">{MAIL[g.mail_state ?? ""] ?? "Mail asked"}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">{g.expires_at ? dateOnly(g.expires_at) : "No end"}</TableCell>
                    <TableCell className="text-xs">{g.admin ?? "—"}</TableCell>
                    <TableCell className="text-xs">{dateTime(g.created_at)}</TableCell>
                    <TableCell>
                      {g.state === "active" && unspent > 0 ? (
                        <Button size="sm" onClick={() => setRevoking(g)}>Revoke unspent…</Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ))}
      {granting && (
        <GrantCreditSheet
          uid={uid}
          email={email}
          onClose={() => setGranting(false)}
          onDone={(g, replay) => {
            upsert(g);
            setGranting(false);
            toast.success(replay ? "Already granted." : `${money(g.amount_cents)} of credit granted.`);
          }}
        />
      )}
      {revoking && (
        <RevokeCreditSheet
          uid={uid}
          grant={revoking}
          onClose={() => setRevoking(null)}
          onDone={(g, cents) => {
            upsert(g);
            setRevoking(null);
            toast.success(cents > 0 ? `${money(cents)} removed.` : "Nothing was left to remove.");
          }}
        />
      )}
    </Panel>
  );
}

type Ends = "90" | "none" | "custom";

export function GrantCreditSheet({
  uid,
  email,
  onClose,
  onDone,
}: {
  uid: string;
  email?: string | null;
  onClose: () => void;
  onDone: (g: CreditGrant, replay: boolean) => void;
}) {
  const { api, withReauth } = useServices();
  // one id for this dialog: a retry after the sign-in grants once
  const rid = useRef(requestId());
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<CreditGrantReason | "">("");
  const [reasonText, setReasonText] = useState("");
  const [ends, setEnds] = useState<Ends>("90");
  const [days, setDays] = useState("30");
  const [notify, setNotify] = useState(false);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [preview, setPreview] = useState<CreditGrantPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [overCapOk, setOverCapOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const cents = parseDollars(amount);
  const amountOk = cents !== null && cents > 0 && cents <= 1_000_000;
  const dayCount = Number(days);
  const daysOk = ends !== "custom" || (Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 3650);
  const expiresDays: number | null = ends === "none" ? null : ends === "custom" ? dayCount : 90;
  const reasonOk = reason !== "" && (reason !== "other" || reasonText.trim().length > 0) && reasonText.length <= 500;
  const overCap = preview?.over_cap === true;

  // the preview follows the amount, reason and end (nothing is granted)
  useEffect(() => {
    if (!amountOk || !reason || !daysOk) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .creditGrantPreview(uid, { amount_cents: cents!, reason, expires_days: expiresDays })
        .then((p) => {
          if (!live) return;
          setPreview(p);
          setPreviewError("");
        })
        .catch((e) => {
          if (!live) return;
          setPreview(null);
          setPreviewError(errorMessage(e));
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [api, uid, cents, amountOk, reason, daysOk, expiresDays]);

  const ready = amountOk && reasonOk && daysOk && preview !== null && (!overCap || overCapOk) && (!notify || message.length <= 1000);

  const confirm = async () => {
    if (!ready || !reason) return;
    setBusy(true);
    setError("");
    try {
      const r = await withReauth(() =>
        api.createCreditGrant(uid, {
          amount_cents: cents!,
          reason,
          ...(reasonText.trim() ? { reason_text: reasonText.trim() } : {}),
          expires_days: expiresDays,
          notify_user: notify,
          ...(notify && message.trim() ? { message: message.trim() } : {}),
          request_id: rid.current,
          ...(overCap ? { confirm_over_cap: true } : {}),
        }),
      );
      onDone(r.grant, r.replay === true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "over_cap") {
        // the cap is lower than the preview said: ask again
        setPreview((p) => (p ? { ...p, over_cap: true } : p));
        setOverCapOk(false);
        setError(err.message);
      } else if (err instanceof ApiError && err.code === "request_id_reused") {
        rid.current = requestId();
        setError("That grant was already sent with other values. Check the list, then try again.");
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      kind="alert"
      title="Grant credit"
      subtitle={email || uid}
      onClose={onClose}
      busy={busy}
      confirmLabel={busy ? "Granting…" : amountOk ? `Grant ${money(cents)}` : "Grant credit"}
      onConfirm={() => void confirm()}
      confirmDisabled={!ready}
    >
      <Field>
        <FieldLabel>Amount (USD)</FieldLabel>
        <FieldControl>
          <Input inputMode="decimal" placeholder="25.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FieldControl>
        <FieldDescription>Usage credit, spent before the card. Never paid out.</FieldDescription>
        <FieldError>{amount && !amountOk ? "Enter an amount from $0.01 to $10,000.00." : null}</FieldError>
      </Field>
      <Field>
        <FieldLabel>Reason</FieldLabel>
        <FieldControl>
          <FilterSelect
            label="Reason"
            size="default"
            className="w-full"
            value={reason}
            allLabel="Pick a reason"
            onChange={(v) => setReason(v as CreditGrantReason | "")}
            options={CREDIT_REASONS.map((r) => ({ value: r.id, label: r.label }))}
          />
        </FieldControl>
        <FieldDescription>Kept for us. The account sees "Credit from Spatial Video Studio".</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>{reason === "other" ? "What for" : "Note (optional)"}</FieldLabel>
        <FieldControl>
          <Textarea rows={2} maxLength={500} value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
        </FieldControl>
        {reason === "other" ? <FieldDescription>Required for Other.</FieldDescription> : null}
      </Field>
      <FieldSet>
        <FieldLegend>Ends</FieldLegend>
        <RadioGroup value={ends} onValueChange={(v) => setEnds(v as Ends)} aria-label="Ends" className="flex flex-wrap gap-x-4">
          {(
            [
              ["90", "In 90 days"],
              ["custom", "After…"],
              ["none", "No end"],
            ] as const
          ).map(([id, text]) => (
            <div key={id} className="flex items-center gap-2">
              <RadioGroupItem value={id} id={`credit-ends-${id}`} />
              <Label htmlFor={`credit-ends-${id}`} className="text-sm text-foreground">{text}</Label>
            </div>
          ))}
        </RadioGroup>
      </FieldSet>
      {ends === "custom" ? (
        <Field>
          <FieldLabel>Days</FieldLabel>
          <FieldControl>
            <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </FieldControl>
          <FieldError>{!daysOk ? "1 to 3,650 days." : null}</FieldError>
        </Field>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          id="credit-notify"
          type="checkbox"
          className="size-4 accent-primary"
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
        />
        <Label htmlFor="credit-notify" className="text-sm text-foreground">
          Email the user{email ? ` (${email})` : ""}
        </Label>
      </div>
      {notify ? (
        <Field>
          <FieldLabel>Message</FieldLabel>
          <FieldControl>
            <Textarea rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
          </FieldControl>
          <FieldDescription>Goes in the mail under the amount. Up to 1,000 characters.</FieldDescription>
        </Field>
      ) : null}
      {preview ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-border px-3 py-2 text-sm" data-testid="credit-preview">
          <dt className="text-muted-foreground">Balance now</dt>
          <dd className="text-right font-mono tabular-nums">{money(preview.balance_before_cents)}</dd>
          <dt className="text-muted-foreground">After the grant</dt>
          <dd className="text-right font-mono tabular-nums">{money(preview.balance_after_cents)}</dd>
          <dt className="text-muted-foreground">Ends</dt>
          <dd className="text-right">{preview.expires_at ? dateOnly(preview.expires_at) : "No end"}</dd>
        </dl>
      ) : previewError ? (
        <Note tone="error">{previewError}</Note>
      ) : null}
      {overCap && preview ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 px-3 py-2" data-testid="credit-over-cap">
          <input
            id="credit-over-cap"
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={overCapOk}
            onChange={(e) => setOverCapOk(e.target.checked)}
          />
          <Label htmlFor="credit-over-cap" className="text-sm text-foreground">
            {money(preview.amount_cents)} is above the {money(preview.cap_cents)} cap. Grant it anyway.
          </Label>
        </div>
      ) : null}
      <PasskeyNote />
      {error && <Note tone="error">{error}</Note>}
    </Modal>
  );
}

function RevokeCreditSheet({
  uid,
  grant,
  onClose,
  onDone,
}: {
  uid: string;
  grant: CreditGrant;
  onClose: () => void;
  onDone: (g: CreditGrant, revokedCents: number) => void;
}) {
  const { api, withReauth } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const unspent = grant.unspent_cents ?? 0;
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await withReauth(() => api.revokeCreditGrant(uid, grant.id));
      onDone(r.grant, r.revoked_cents);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      kind="alert"
      title="Revoke unspent credit"
      subtitle={`${money(grant.amount_cents)} granted ${dateOnly(grant.created_at)}${grant.admin ? ` by ${grant.admin}` : ""}`}
      onClose={onClose}
      busy={busy}
      confirmLabel={busy ? "Removing…" : `Remove ${money(unspent)}`}
      confirmVariant="destructive"
      onConfirm={() => void confirm()}
    >
      <p className="text-sm">
        Removes the {money(unspent)} still unspent from this grant. What was already spent stays spent; other credit and the
        balance stay.
      </p>
      <PasskeyNote />
      {error && <Note tone="error">{error}</Note>}
    </Modal>
  );
}
