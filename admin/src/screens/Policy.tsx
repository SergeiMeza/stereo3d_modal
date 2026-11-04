import { ErrorState, KV, PageHeader, Panel, SkeletonRows } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "../lib/api";
import { money, pct, words } from "../lib/format";
import { useQuery } from "@/state/query";
import { policyQuery } from "@/state/queries";

/** The refund policy in force (C12). Read-only: it's edited in Firestore. */
export function PolicyPage() {
  const { state, retry } = useQuery(policyQuery, null);
  return (
    <>
      <PageHeader title="Refund policy">
        {state.kind === "loaded" && (
          <span className="text-sm text-muted-foreground">
            Read-only · edit in Firestore <span className="font-mono">{state.data.edit_in}</span> (changes are logged)
          </span>
        )}
      </PageHeader>
      {state.kind === "loading" && <SkeletonRows rows={6} cols={2} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the policy." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && (() => {
        const p = state.data.policy;
        const exempt = new Set(p.cap_exempt ?? []);
        return (
          <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-start gap-4 max-[1000px]:grid-cols-1">
            <Panel title="Reasons" note="unknown reasons are manual">
              <Table>
                <TableHeader><TableRow><TableHead>Reason</TableHead><TableHead>Mode</TableHead><TableHead>Cap</TableHead></TableRow></TableHeader>
                <TableBody>
                  {Object.entries(p.reasons ?? {})
                    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
                    .map(([r, m]) => (
                      <TableRow key={r}>
                        <TableCell className="font-mono">{r}</TableCell>
                        <TableCell><Badge variant={m === "auto" ? "green" : "amber"}>{m}</Badge></TableCell>
                        <TableCell className="text-muted-foreground tabular-nums">
                          {exempt.has(r) ? "exempt" : m === "auto" ? `manual over ${money(p.manual_above_cents)}` : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </Panel>
            <Panel title="Settings">
              <KV>
                <dt>Manual above</dt><dd className="tabular-nums">{money(p.manual_above_cents)}</dd>
                <dt>Deadline</dt><dd>{p.deadline_business_days} business days</dd>
                <dt>Reminders</dt><dd>after {p.reminder_hours} h</dd>
                <dt>Time zone</dt><dd>{p.timezone}</dd>
                <dt>Dispute line</dt><dd className="tabular-nums">{pct(p.dispute_alert_pct)}</dd>
                <dt>Slack</dt><dd>{p.notify?.slack_channel || "gateway default"}</dd>
                <dt>Owner mails</dt><dd>{(p.notify?.owner_emails ?? []).join(", ") || "gateway default"}</dd>
                <dt>Cap exempt</dt><dd>{[...exempt].map(words).join(", ") || "—"}</dd>
              </KV>
            </Panel>
          </div>
        );
      })()}
    </>
  );
}
