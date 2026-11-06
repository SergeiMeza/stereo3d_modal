import { useSetAtom } from "jotai";
import { useEffect, useState } from "react";

import { toast } from "sonner";

import { Modal, Note, Panel } from "@/components/common";
import { PasskeyNote } from "@/components/PasskeyNote";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldControl, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, errorMessage } from "../lib/api";
import { dateOnly, dateTime, money, until, words } from "../lib/format";
import { Link, paths } from "../lib/router";
import { useServices } from "../lib/services";
import type { AccountHit, CasePage, CasePlanMove, PlanMovePreview } from "../lib/types";
import { accountSearchQuery, caseQuery, planMovePreviewQuery } from "@/state/queries";
import { useQuery } from "@/state/query";

/**
 * RP-05 (owner 2026-11-06): support moves a web plan off a live account
 * after a manual check of who owns it. The console offers the move; only
 * the receiving account can accept it (a fresh sign-in there), within 7
 * days. Gateway 088d57f: a plan_move case (the ownership check is its
 * text), the preview with its blockers, then offer_plan_move (a money
 * action: the passkey within 5 minutes).
 */

/** The gateway's blockers, in plain words. */
export const BLOCKER_WORDS: Record<string, string> = {
  same_account: "That's the same account.",
  no_plan: "This account has no web plan to move.",
  plan_renewing: "The plan still renews. The customer cancels it first; then it can move until its end.",
  target_has_plan: "The receiving account has a plan of its own.",
  target_missing: "The receiving account doesn't exist or is being deleted.",
  from_deleted: "This account is deleted. The customer uses Restore Purchases instead.",
  move_open: "A move of this plan is already open.",
};

export const MOVE_WORDS: Record<string, string> = {
  plan: "The plan, until its period ends",
  app_access: "Pro and the plan in the app",
  current_usage: "This period's usage left",
  months_not_yet_given: "The months not given yet (yearly plan)",
};

export const STAY_WORDS: Record<string, string> = {
  usage_already_used: "Usage already used",
  balance: "The balance",
  app_store_purchases: "App Store purchases",
  admin_grants: "Grants made here",
  past_runs_and_files: "Past runs and files",
};

export function blockerText(b: string): string {
  return BLOCKER_WORDS[b] ?? words(b);
}

/** The gateway checks the trimmed text: at least 10 characters. */
export const OWNERSHIP_MIN = 10;
const OWNERSHIP_MAX = 2000;

/**
 * Move plan…: the receiving account (the account search), how ownership
 * was checked, the preview (what moves, what stays, blockers), the
 * passkey, then Offer. `caseId` is an existing plan_move case (the case
 * page's "Offer a move…"); without it, checking the move opens one.
 */
export function PlanMoveSheet({
  fromUid,
  caseId: givenCase,
  onClose,
  onOffered,
}: {
  fromUid: string;
  caseId?: string;
  onClose: () => void;
  onOffered: (page: CasePage) => void;
}) {
  const { api, withReauth } = useServices();
  const setCase = useSetAtom(caseQuery.put);
  // the box's text, its debounced copy and the pick: local, ephemeral UI
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<AccountHit | null>(null);
  const [ownership, setOwnership] = useState("");
  const [caseId, setCaseId] = useState(givenCase ?? "");
  const [checkedFor, setCheckedFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const term = q.trim();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 250);
    return () => clearTimeout(t);
  }, [term]);
  const searchable = !picked && debounced === term && term.length >= 2 && term.length <= 320;
  const search = useQuery(accountSearchQuery, debounced, searchable);
  const hits = searchable && search.state.kind === "loaded" ? search.state.data.filter((h) => h.uid !== fromUid) : null;

  const ownershipOk = ownership.trim().length >= OWNERSHIP_MIN && ownership.length <= OWNERSHIP_MAX;
  const previewParams = { caseId, to: checkedFor };
  const preview = useQuery(planMovePreviewQuery, previewParams, Boolean(caseId && checkedFor));
  const shown: PlanMovePreview | null =
    caseId && checkedFor && preview.state.kind === "loaded" ? preview.state.data : null;
  const blockers = shown?.blockers ?? [];
  const current = picked !== null && checkedFor === picked.uid;
  const canOffer = current && shown !== null && blockers.length === 0 && Boolean(shown.subscription_id) && ownershipOk;

  const check = async () => {
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      let id = caseId;
      if (!id) {
        // the plan_move case; its text is how ownership was checked
        const res = await api.openCase({ uid: fromUid, reason: "plan_move", text: ownership.trim() });
        const page = res.cases?.[0];
        if (!page) throw new Error("No case came back.");
        setCase(page.case.id, page);
        id = page.case.id;
        setCaseId(id);
      }
      setCheckedFor(picked.uid);
      if (id === caseId && checkedFor === picked.uid) await preview.reload();
    } catch (err) {
      setError(`That didn't work: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const offer = async () => {
    if (!picked || !shown?.subscription_id) return;
    setBusy(true);
    setError("");
    try {
      const page = await withReauth(() =>
        api.caseAction(caseId, {
          action: "offer_plan_move",
          to_uid: picked.uid,
          expected_subscription_id: shown.subscription_id,
          text: ownership.trim(),
        }),
      );
      setCase(caseId, page);
      onOffered(page);
    } catch (err) {
      if (err instanceof ApiError && err.code === "subscription_changed") {
        setError("The account's plan changed. Look at the preview again.");
        void preview.reload();
      } else if (err instanceof ApiError && BLOCKER_WORDS[err.code]) {
        setError(blockerText(err.code));
        void preview.reload();
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      kind="sheet"
      wide
      title="Move plan"
      subtitle="Offer this account's web plan to another account. The other account accepts it within 7 days."
      onClose={onClose}
      busy={busy}
      confirmLabel={busy ? "Working…" : "Offer the move"}
      onConfirm={() => void offer()}
      confirmDisabled={!canOffer}
    >
      <Field>
        <FieldLabel>Receiving account</FieldLabel>
        {picked ? (
          <div className="flex items-center gap-2 text-sm" data-testid="move-picked">
            <span className="font-medium">{picked.email || picked.uid}</span>
            <span className="font-mono text-xs text-muted-foreground">{picked.uid}</span>
            {picked.plan ? <Badge variant="amber">{picked.plan}</Badge> : null}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              disabled={busy}
              onClick={() => {
                setPicked(null);
                setCheckedFor("");
              }}
            >
              Change
            </Button>
          </div>
        ) : (
          <>
            <FieldControl>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Email or uid" autoComplete="off" />
            </FieldControl>
            <FieldDescription>Search by email or uid, then pick the account.</FieldDescription>
            {searchable && search.state.kind === "loading" ? <Note>Searching…</Note> : null}
            {searchable && search.state.kind === "error" ? <Note tone="error">Search didn't work.</Note> : null}
            {hits && hits.length === 0 ? <Note>No other account matches.</Note> : null}
            {hits && hits.length > 0 ? (
              <ul className="flex list-none flex-col gap-1" aria-label="Accounts found" data-testid="move-hits">
                {hits.map((h) => (
                  <li key={h.uid}>
                    <Button variant="ghost" className="h-auto w-full justify-start gap-2 py-1.5 text-left" onClick={() => setPicked(h)}>
                      <span className="truncate">{h.email || h.uid}</span>
                      <span className="font-mono text-xs text-muted-foreground">{h.uid}</span>
                      {h.plan ? <Badge variant="amber">{h.plan}</Badge> : null}
                      {h.deleted ? <Badge variant="muted">Deleted</Badge> : null}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </Field>

      <Field>
        <FieldLabel>How was ownership checked?</FieldLabel>
        <FieldControl>
          <Textarea rows={3} maxLength={OWNERSHIP_MAX} value={ownership} onChange={(e) => setOwnership(e.target.value)} />
        </FieldControl>
        <FieldDescription>Required, at least {OWNERSHIP_MIN} characters. It goes on the case.</FieldDescription>
      </Field>

      <Button onClick={() => void check()} disabled={!picked || !ownershipOk || busy} className="self-start">
        {current && shown ? "Check again" : "Check the move"}
      </Button>

      {current && preview.state.kind === "loading" ? <Note>Checking…</Note> : null}
      {current && preview.state.kind === "error" ? (
        <Note tone="error">Couldn't check the move: {errorMessage(preview.state.error)}</Note>
      ) : null}
      {current && shown ? <PreviewBody preview={shown} /> : null}

      {canOffer ? <PasskeyNote /> : null}
      {error && <Note tone="error">{error}</Note>}
    </Modal>
  );
}

function PreviewBody({ preview: p }: { preview: PlanMovePreview }) {
  const blockers = p.blockers ?? [];
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border px-3.5 py-3 text-sm" data-testid="move-preview">
      {p.plan ? (
        <p>
          <span className="font-medium">{words(p.plan_id || p.plan)}</span>
          {p.period_end ? ` · ${p.renews ? "renews" : "ends"} ${dateOnly(p.period_end)}` : ""}
        </p>
      ) : null}
      {blockers.length > 0 ? (
        <ul className="flex list-none flex-col gap-1" aria-label="Can't move" data-testid="move-blockers">
          {blockers.map((b) => (
            <li key={b} className="text-destructive-foreground">
              {blockerText(b)}
            </li>
          ))}
        </ul>
      ) : null}
      {(p.moves ?? []).length > 0 ? (
        <div>
          <div className="text-xs text-muted-foreground">Moves</div>
          <ul className="list-disc pl-5" data-testid="move-moves">
            {(p.moves ?? []).map((m) => (
              <li key={m}>
                {MOVE_WORDS[m] ?? words(m)}
                {m === "current_usage" && typeof p.carry_cents === "number" ? ` (${money(p.carry_cents)})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {(p.stays ?? []).length > 0 ? (
        <div>
          <div className="text-xs text-muted-foreground">Stays on this account</div>
          <ul className="list-disc pl-5" data-testid="move-stays">
            {(p.stays ?? []).map((m) => (
              <li key={m}>{STAY_WORDS[m] ?? words(m)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

type MoveTone = "blue" | "amber" | "green" | "muted";

const MOVE_STATE: Record<string, { label: string; tone: MoveTone; note: string }> = {
  offered: { label: "Offered", tone: "blue", note: "Waiting for the receiving account to accept it." },
  accepted: { label: "Accepted", tone: "amber", note: "The receiving account accepted it; the move is finishing." },
  done: { label: "Done", tone: "green", note: "The plan is on the receiving account now." },
  expired: { label: "Expired", tone: "muted", note: "Not accepted within 7 days. Nothing moved." },
  cancelled: { label: "Cancelled", tone: "muted", note: "Withdrawn. Nothing moved." },
};

/** The move's state as it stands: an offer past its 7 days reads expired
 * (the gateway marks it when someone tries to accept it). */
export function moveState(m: CasePlanMove, now = Date.now()): string {
  if (m.state === "offered" && Date.parse(m.expires_at) <= now) return "expired";
  return m.state;
}

/** RP-05 on a plan_move case: the move's state, Cancel move while it's
 * offered, and Offer a move… when no offer is waiting. */
export function PlanMovePanel({ page, onPage }: { page: CasePage; onPage: (p: CasePage) => void }) {
  const { api } = useServices();
  const [offering, setOffering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const c = page.case;
  const actions = page.actions ?? [];
  const m = c.plan_move ?? null;
  const st = m ? moveState(m) : null;
  const info = st ? MOVE_STATE[st] ?? { label: words(st), tone: "muted" as MoveTone, note: "" } : null;
  const canCancel = st === "offered" && actions.includes("cancel_plan_move");
  const canOffer = c.open && actions.includes("offer_plan_move") && (st === null || st === "expired" || st === "cancelled");

  const cancel = async () => {
    setBusy(true);
    setError("");
    try {
      onPage(await api.caseAction(c.id, { action: "cancel_plan_move" }));
      setCancelling(false);
      toast.success("Move cancelled.");
    } catch (err) {
      setError(err instanceof ApiError && err.code === "no_move" ? err.message : `That didn't work: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Plan move"
      note="RP-05: support moves this account's web plan to another account"
      action={
        canCancel ? (
          <Button onClick={() => setCancelling(true)}>Cancel move…</Button>
        ) : canOffer ? (
          <Button variant="default" onClick={() => setOffering(true)}>Offer a move…</Button>
        ) : undefined
      }
      data-testid="plan-move"
    >
      <div className="flex flex-col gap-2 px-4 py-3 text-sm">
        {m && info ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={info.tone} data-testid="plan-move-state">{info.label}</Badge>
              <span className="text-muted-foreground">{info.note}</span>
            </div>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 [&_dt]:text-muted-foreground" data-testid="plan-move-facts">
              <dt>From</dt>
              <dd>
                <Link className="font-mono text-link hover:underline" to={paths.account(m.from_uid)}>{m.from_uid}</Link>
              </dd>
              <dt>To</dt>
              <dd>
                <Link className="font-mono text-link hover:underline" to={paths.account(m.to_uid)}>{m.to_uid}</Link>
              </dd>
              <dt>Plan</dt>
              <dd>{words(m.plan)} · ends {dateOnly(m.period_end)}</dd>
              <dt>Offered</dt>
              <dd>{dateTime(m.offered_at)} by {m.offered_by}</dd>
              {st === "offered" && (
                <>
                  <dt>Expires</dt>
                  <dd>{dateTime(m.expires_at)} · {until(m.expires_at)}</dd>
                </>
              )}
              {m.accepted_at && (
                <>
                  <dt>Accepted</dt>
                  <dd>{dateTime(m.accepted_at)}</dd>
                </>
              )}
              {m.done_at && (
                <>
                  <dt>Done</dt>
                  <dd>{dateTime(m.done_at)}</dd>
                </>
              )}
            </dl>
          </>
        ) : (
          <Note>No move offered yet.</Note>
        )}
        {error && <Note tone="error">{error}</Note>}
      </div>
      {cancelling && (
        <Modal
          kind="alert"
          title="Cancel the move?"
          subtitle="The receiving account can't accept it any more. Nothing has moved."
          onClose={() => setCancelling(false)}
          busy={busy}
          confirmLabel={busy ? "Cancelling…" : "Cancel move"}
          confirmVariant="destructive"
          cancelLabel="Keep the offer"
          onConfirm={() => void cancel()}
        />
      )}
      {offering && (
        <PlanMoveSheet
          fromUid={c.uid}
          caseId={c.id}
          onClose={() => setOffering(false)}
          onOffered={(next) => {
            onPage(next);
            setOffering(false);
            toast.success("Move offered. The receiving account has 7 days to accept it.");
          }}
        />
      )}
    </Panel>
  );
}
