import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Banner, EmptyRow, ErrorState, LoadingBlock, MiniTable, Note, Panel, PlainText, StateBox } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ApiError, errorMessage } from "../lib/api";
import { dateOnly, dateTime, money, until, words } from "../lib/format";
import { statusLabel, statusTone, typeLabel, typeTone } from "../lib/labels";
import { Link, paths, useRouter } from "../lib/router";
import { useServices } from "../lib/services";
import type { CaseAction, CasePage as Page, MailPreviewsResponse } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { ActionSheet, approveItems, isBalanceCase, owedTotal } from "./ActionSheet";
import { deliveredChip, EvidencePanel } from "./CaseEvidence";

/** A2: one case. */
export function CasePage({ id }: { id: string }) {
  const { api } = useServices();
  const { state, retry, reload, set } = useLoad(() => api.getCase(id), [api, id]);
  const [previews, setPreviews] = useState<MailPreviewsResponse | null>(null);

  useEffect(() => {
    api.mailPreviews().then(setPreviews).catch(() => setPreviews(null));
  }, [api]);

  return (
    <>
      <Link to={paths.cases()} className="w-fit text-xs text-muted-foreground hover:text-foreground">← Cases</Link>
      {state.kind === "loading" && <LoadingBlock label="Loading the case" />}
      {state.kind === "error" &&
        (state.error instanceof ApiError && state.error.status === 404 ? (
          <StateBox title={`No case ${id}.`} />
        ) : (
          <ErrorState title="Couldn't load the case." message={errorMessage(state.error)} onRetry={retry} />
        ))}
      {state.kind === "loaded" && (
        <CaseBody page={state.data} previews={previews} onPage={set} onReload={reload} />
      )}
    </>
  );
}

const LABELS: Partial<Record<CaseAction, string>> = {
  partial: "Partial…",
  deny: "Deny…",
  no_refund: "No refund",
  ask: "Ask the customer…",
  customer_reply: "Customer replied…",
  mark_out_of_band: "Mark refunded outside Stripe…",
  assign: "Assign refund…",
  stop_run: "Stop run now",
  accept_dispute: "Accept",
  counter_dispute: "Counter",
  counter_with_refund_proof: "Counter with refund proof",
};

function CaseBody({
  page,
  previews,
  onPage,
  onReload,
}: {
  page: Page;
  previews: MailPreviewsResponse | null;
  onPage: (p: Page) => void;
  onReload: () => Promise<Page>;
}) {
  const { api } = useServices();
  const { search } = useRouter();
  const [sheet, setSheet] = useState<CaseAction | null>(null);
  // /cases/:id?decide=1 (Overview's Next up, the list's D) opens the decision sheet
  const [deciding, setDeciding] = useState(() => search.get("decide") === "1");
  const [inlineErr, setInlineErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const c = page.case;
  const actions = page.actions ?? [];
  const has = (a: CaseAction) => actions.includes(a);
  const runs = page.runs ?? [];
  const evRuns = page.evidence?.runs ?? [];
  const max = page.max_refundable_cents;
  const waive = c.type === "waive";
  const banners = page.banners ?? [];
  const hints = page.hints ?? [];
  const refunded = (page.refunds ?? []).some((r) => ["pending", "succeeded", "out_of_band"].includes(r.status));
  const pm = page.account.payment_method ?? "";
  const windowed = /alipay|wechat/i.test(pm);
  const downloadsByRun = (() => {
    const d = page.evidence?.downloads;
    if (!Array.isArray(d)) return null;
    const m: Record<string, number> = {};
    for (const x of d) if (x.conversion_id) m[x.conversion_id] = (m[x.conversion_id] ?? 0) + 1;
    return m;
  })();

  // A customer message on a closed case opens a new linked case (gateway
  // 00107): the new one names follow_up_of, the closed one lists its
  // follow_up_ids, both top-level on the case.
  const followUpOf = c.follow_up_of || "";
  const followUps = [...new Set(c.follow_up_ids ?? [])].filter((id) => id && id !== followUpOf);

  const done = (next: Page) => {
    onPage(next);
    setSheet(null);
    toast.success("Done.");
  };

  const refresh = async () => {
    setRefreshing(true);
    setInlineErr("");
    try {
      onPage(await api.caseAction(c.id, { action: "refresh_evidence" }));
    } catch (err) {
      setInlineErr(`That didn't work: ${errorMessage(err)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const primary: CaseAction[] = [];
  if (has("approve")) primary.push("approve");
  if (has("waive")) primary.push("waive");
  if (has("counter_with_refund_proof") && refunded) primary.push("counter_with_refund_proof");
  const secondary = actions.filter(
    (a) => !primary.includes(a) && !["note", "refresh_evidence", "close", "approve", "waive"].includes(a),
  );
  const approveDisabled = max <= 0 || Object.keys(approveItems(page)).length === 0 && !isBalanceCase(page);
  const decisions = [...primary, ...secondary];
  const decisionLabel = (a: CaseAction) =>
    a === "approve" ? `Approve ${money(max)}` : a === "waive" ? `Waive ${money(owedTotal(page))}` : LABELS[a] ?? words(a);

  const linkCls = "font-mono text-link hover:underline";
  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-medium">{c.id}</h1>
          <Badge variant={typeTone(c.type)}>{typeLabel(c.type)}</Badge>
          <span className="text-muted-foreground">{words(c.reason)} · {c.mode}</span>
          <Badge variant={statusTone(c.status, c.result)}>{statusLabel(c.status, c.result)}</Badge>
          {c.deadline_at && c.open && (
            <span
              className={cn(
                "ml-auto text-xs whitespace-nowrap tabular-nums",
                new Date(c.deadline_at).getTime() - Date.now() < 12 * 3600e3 ? "font-medium text-destructive-foreground" : "text-warning-foreground",
              )}
            >
              Due {dateTime(c.deadline_at)} · {until(c.deadline_at)}
            </span>
          )}
        </div>
        <Facts>
          <span>
            Account{" "}
            {c.uid ? (
              <Link className="text-link hover:underline" to={paths.account(c.uid)}>{page.account.email || c.uid}</Link>
            ) : (
              <span className="text-muted-foreground">none</span>
            )}
          </span>
          {pm && <span>Method <b className="font-medium text-foreground">{pm}</b></span>}
          <span>Opened {dateTime(c.opened_at)} by {c.source}</span>
          <span>{c.customer_visible ? "Customer-visible" : "Not customer-visible"}</span>
          {c.decision && (
            <span>
              Decision <b className="font-medium text-foreground">{words(c.decision.kind)}</b> by {c.decision.by} · {dateTime(c.decision.at)}
            </span>
          )}
        </Facts>
      </div>

      {windowed && c.open && c.deadline_at && (
        <Banner tone="amber">
          Refund window closes {until(c.deadline_at)}: {pm} refunds are only possible for a limited time.
        </Banner>
      )}
      {banners.map((b, i) => (
        <Banner
          key={i}
          tone={/failed/i.test(b) ? "red" : /superseded/i.test(b) ? "amber" : "blue"}
          action={
            c.status === "waiting_for_run" && has("stop_run") && /waiting for the run/i.test(b) ? (
              <Button size="sm" onClick={() => setSheet("stop_run")}>Stop run now</Button>
            ) : /failed/i.test(b) && has("mark_out_of_band") ? (
              <Button size="sm" onClick={() => setSheet("mark_out_of_band")}>Mark refunded outside Stripe…</Button>
            ) : undefined
          }
        >
          <PlainText text={b} inline />
        </Banner>
      ))}
      {c.related.superseded_by && (
        <p className="text-sm">
          Superseded by <Link className={linkCls} to={paths.case(c.related.superseded_by)}>{c.related.superseded_by}</Link>
        </p>
      )}
      {followUpOf && (
        <p className="text-sm" data-testid="follow-up-of">
          Follow-up of <Link className={linkCls} to={paths.case(followUpOf)}>{followUpOf}</Link>
        </p>
      )}
      {followUps.length > 0 && (
        <p className="text-sm" data-testid="follow-ups">
          Follow-up{followUps.length > 1 ? "s" : ""}:{" "}
          {followUps.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <Link className={linkCls} to={paths.case(id)}>{id}</Link>
            </span>
          ))}
        </p>
      )}
      {c.related.duplicate_of && (
        <p className="text-sm">
          Duplicate of <Link className={linkCls} to={paths.case(c.related.duplicate_of)}>{c.related.duplicate_of}</Link>
        </p>
      )}

      {c.dispute && (
        <Card className="px-4 py-3">
          <Facts>
            <span>Dispute <b className="font-mono font-medium text-foreground">{c.dispute.id}</b></span>
            <span>Amount <b className="font-medium text-foreground tabular-nums">{money(c.dispute.amount_cents)}</b></span>
            <span>Reason <b className="font-medium text-foreground">{words(c.dispute.reason)}</b></span>
            <span>Status <b className="font-medium text-foreground">{words(c.dispute.status)}</b></span>
            {c.dispute.due_by && (
              <span>
                Evidence due <b className="font-medium text-foreground">{dateTime(c.dispute.due_by)}</b> · {until(c.dispute.due_by)}
              </span>
            )}
            {c.dispute.outcome && <span>Outcome <b className="font-medium text-foreground">{c.dispute.outcome}</b></span>}
          </Facts>
        </Card>
      )}

      {runs.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead numeric>Price</TableHead>
                {waive ? <TableHead numeric>Owed</TableHead> : <TableHead numeric>Refunded so far</TableHead>}
                {!waive && <TableHead numeric>Refundable now</TableHead>}
                <TableHead>Paid from</TableHead>
                <TableHead>Delivered</TableHead>
                <TableHead numeric>Downloads</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.conversion_id}>
                  <TableCell>
                    <span className="font-mono text-xs text-muted-foreground">{r.conversion_id}</span> {r.label}
                  </TableCell>
                  <TableCell numeric>{money(r.price_cents)}</TableCell>
                  {waive ? (
                    <TableCell numeric><b>{money(r.owed_cents ?? 0)}</b></TableCell>
                  ) : (
                    <TableCell numeric>{money(r.refunded_cents ?? 0)}</TableCell>
                  )}
                  {!waive && <TableCell numeric><b>{money(r.refundable_cents)}</b></TableCell>}
                  <TableCell>{words(r.paid_from)}</TableCell>
                  <TableCell>{deliveredChip(r.delivered, evRuns.find((e) => e.conversion_id === r.conversion_id))}</TableCell>
                  <TableCell numeric>{downloadsByRun ? downloadsByRun[r.conversion_id] ?? 0 : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {runs.length === 0 && isBalanceCase(page) && (
        <p className="text-sm">Balance refund · refundable now <b className="tabular-nums">{money(max)}</b></p>
      )}

      {c.customer_text && (
        <Card className="px-4 py-3">
          <div className="text-xs text-muted-foreground">Customer's message</div>
          <PlainText text={c.customer_text} />
        </Card>
      )}

      {hints.map((h, i) => (
        <p key={i} className="border-l-2 border-violet pl-2.5 text-sm text-muted-foreground">
          <PlainText text={h} inline />
        </p>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        {decisions.length > 0 ? (
          <Button variant="default" size="lg" onClick={() => setDeciding(true)} className="tabular-nums">
            Decide{has("approve") && !approveDisabled ? ` · up to ${money(max)}` : ""}
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">No decisions on this case now.</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {has("refresh_evidence") && (
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? "Working…" : "Refresh evidence"}
            </Button>
          )}
          {has("close") ? (
            <Button variant="ghost" size="sm" onClick={() => setSheet("close")}>
              Close
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* a disabled button gets no pointer events: the span carries the tooltip */}
                <span tabIndex={0} className="rounded-md">
                  <Button variant="ghost" size="sm" disabled>
                    Close
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Closed cases are final.</TooltipContent>
            </Tooltip>
          )}
        </span>
      </div>
      {inlineErr && <Note tone="error">{inlineErr}</Note>}

      <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-start gap-4 max-[1000px]:grid-cols-1">
        <EvidencePanel evidence={page.evidence} n={c.evidence_n} />
        <Panel title="Timeline">
          <div className="flex flex-col gap-3 px-4 py-3">
            {has("note") && <NoteBox caseId={c.id} onPage={onPage} />}
            <Timeline page={page} />
          </div>
          <SubHead>Related cases</SubHead>
          {(page.related_cases ?? []).length === 0 ? (
            <EmptyRow>None for this account.</EmptyRow>
          ) : (
            <MiniTable>
              {(page.related_cases ?? []).map((r) => (
                <tr key={r.id}>
                  <td><Link className={linkCls} to={paths.case(r.id)}>{r.id}</Link></td>
                  <td>{words(r.type)} · {words(r.reason)}</td>
                  <td>{statusLabel(r.status, r.result)}</td>
                </tr>
              ))}
            </MiniTable>
          )}
          {(c.related.linked_case_ids ?? []).length > 0 && (
            <p className="px-4 py-3 text-xs">
              Linked:{" "}
              {(c.related.linked_case_ids ?? []).map((l) => (
                <Link key={l} className={linkCls} to={paths.case(l)}>{l} </Link>
              ))}
            </p>
          )}
          <SubHead>Refunds</SubHead>
          {(page.refunds ?? []).length === 0 ? (
            <EmptyRow>No refunds on this payment.</EmptyRow>
          ) : (
            <MiniTable>
              {(page.refunds ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="font-mono">{r.re_id || r.id}</td>
                  <td className="text-right font-mono tabular-nums">{money(r.total_cents)}</td>
                  <td>{words(r.status)}{r.fail_reason ? ` · ${r.fail_reason}` : ""}</td>
                  <td>{dateOnly(r.created_at)}</td>
                </tr>
              ))}
            </MiniTable>
          )}
        </Panel>
      </div>

      <Sheet open={deciding && decisions.length > 0} onOpenChange={setDeciding}>
        <SheetContent className="sm:max-w-[460px]">
          <SheetHeader>
            <span className="text-xs text-muted-foreground">Step 1 of 2 · Choose</span>
            <SheetTitle>Decide {c.id}</SheetTitle>
            <SheetDescription>
              {typeLabel(c.type)} · {words(c.reason)}. Money moves only after you confirm the next step.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 rounded-lg border border-border bg-secondary p-3.5 text-sm [&_dt]:text-muted-foreground">
              <dt>{waive ? "Owed" : "Refundable now"}</dt>
              <dd className="font-mono tabular-nums">{money(waive ? owedTotal(page) : max)}</dd>
              {pm && (
                <>
                  <dt>Method</dt>
                  <dd>{pm}</dd>
                </>
              )}
              <dt>Customer</dt>
              <dd className="truncate">{page.account.email || c.uid || "none"}</dd>
              {c.deadline_at && c.open && (
                <>
                  <dt>Due</dt>
                  <dd className="tabular-nums">{dateTime(c.deadline_at)} · {until(c.deadline_at)}</dd>
                </>
              )}
            </dl>
            <div className="flex flex-col gap-2" role="group" aria-label="Decisions">
              {decisions.map((a) => (
                <Button
                  key={a}
                  variant={primary.includes(a) ? "default" : "outline"}
                  size="lg"
                  className="w-full justify-start tabular-nums"
                  disabled={a === "approve" && approveDisabled}
                  onClick={() => {
                    setDeciding(false);
                    setSheet(a);
                  }}
                >
                  {decisionLabel(a)}
                </Button>
              ))}
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>

      {sheet && (
        <ActionSheet
          action={sheet}
          page={page}
          previews={previews}
          onClose={() => setSheet(null)}
          onDone={done}
          onReload={onReload}
        />
      )}
    </>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">{children}</div>;
}

function SubHead({ children }: { children: ReactNode }) {
  return <h3 className="border-y border-border px-4 py-3 text-sm font-semibold">{children}</h3>;
}


function NoteBox({ caseId, onPage }: { caseId: string; onPage: (p: Page) => void }) {
  const { api } = useServices();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      onPage(await api.caseAction(caseId, { action: "note", text: text.trim() }));
      setText("");
    } catch (e) {
      setErr(
        e instanceof ApiError && e.code === "case_closed"
          ? "Reopen the case to add notes."
          : `That didn't work: ${errorMessage(e)}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Textarea
        rows={2}
        placeholder="Add a note…"
        aria-label="Add a note"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button size="sm" onClick={() => void save()} disabled={busy || !text.trim()}>
        {busy ? "Working…" : "Add note"}
      </Button>
      {err && <Note tone="error" className="text-xs">{err}</Note>}
    </div>
  );
}

function Timeline({ page }: { page: Page }) {
  const events = [...(page.events ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  if (events.length === 0) return <p className="text-xs text-muted-foreground">No events yet.</p>;
  return (
    <ol className="flex list-none flex-col gap-3 p-0" data-testid="timeline">
      {events.map((e) => {
        const sys = e.who === "system";
        const cust = e.who === "customer";
        return (
          <li key={e.id || e.at + e.kind} className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-sm [&>p]:col-start-2 [&>div]:col-start-2">
            <span
              className={cn(
                "h-fit max-w-40 truncate rounded-md px-1.5 py-px text-2xs font-semibold",
                sys ? "bg-secondary text-muted-foreground" : cust ? "bg-warning/12 text-warning-foreground" : "bg-primary/12 text-link",
              )}
            >
              {sys ? "system" : cust ? "customer" : e.who}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {dateTime(e.at)} · {words(e.kind)}
            </span>
            {e.kind === "promo_restored" && e.data ? <PromoRestored data={e.data} /> : e.text && <PlainText text={e.text} />}
          </li>
        );
      })}
    </ol>
  );
}

type PromoGrantRow = { entitlement?: string; ends_at?: string | null };

/** An owner's restore of promotional grants on a closed dispute case (gateway 00107). */
function PromoRestored({ data }: { data: Record<string, unknown> }) {
  const rows = (v: unknown): PromoGrantRow[] => (Array.isArray(v) ? (v as PromoGrantRow[]) : []);
  const one = (g: PromoGrantRow) => {
    const name = words(g.entitlement || "pro");
    const ent = name.charAt(0).toUpperCase() + name.slice(1);
    return g.ends_at ? `${ent} until ${dateOnly(g.ends_at)}` : `${ent}, no end date`;
  };
  const regranted = rows(data.regranted);
  const skipped = rows(data.skipped);
  const by = typeof data.by === "string" ? data.by : "the owner";
  const reason = typeof data.reason === "string" ? data.reason : "";
  return (
    <div className="text-xs" data-testid="promo-restored">
      <PlainText text={`Promotional grants restored by ${by}${reason ? `: ${reason}` : ""}`} />
      <div>Given back: {regranted.length ? regranted.map(one).join(", ") : "none"}</div>
      {skipped.length > 0 && <div className="text-muted-foreground">Skipped (already ended): {skipped.map(one).join(", ")}</div>}
    </div>
  );
}
