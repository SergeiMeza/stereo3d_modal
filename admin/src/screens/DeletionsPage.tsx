import { useState } from "react";

import { ErrorState, FilterSelect, PageHeader, Panel, SkeletonRows, StateBox } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "@/lib/api";
import { dateTime, words } from "@/lib/format";
import { Link, paths } from "@/lib/router";
import type { AdminDeletion } from "@/lib/types";
import { deletionsQuery } from "@/state/queries";
import { useQuery } from "@/state/query";
import { deletionState } from "./Deletion";

/**
 * Deletions (Support, gateway 00166): the 48-hour account deletions, by
 * state, soonest first (GET /v1/admin/deletions?state=). Pending ones
 * show when they go and whether the scheduled run is blocked. Cancel and
 * Process now are on the account page.
 */
export function DeletionsPage() {
  const [state, setState] = useState<AdminDeletion["state"]>("pending");
  const { state: q, retry } = useQuery(deletionsQuery, state);
  return (
    <>
      <PageHeader
        title="Deletions"
        actions={
          <FilterSelect
            label="State"
            value={state}
            onChange={(v) => setState(v as AdminDeletion["state"])}
            options={[
              { value: "pending", label: "Pending" },
              { value: "cancelled", label: "Cancelled" },
              { value: "done", label: "Deleted" },
            ]}
          />
        }
      >
        <span className="text-sm text-muted-foreground">Accounts wait 48 hours before they&apos;re deleted.</span>
      </PageHeader>
      {q.kind === "loading" && <SkeletonRows rows={5} cols={5} />}
      {q.kind === "error" && <ErrorState title="Couldn't load the deletions." message={errorMessage(q.error)} onRetry={retry} />}
      {q.kind === "loaded" &&
        (q.data.length === 0 ? (
          <StateBox title={state === "pending" ? "No accounts waiting to be deleted." : "None."} />
        ) : (
          <Panel title={state === "pending" ? "Waiting" : state === "cancelled" ? "Cancelled" : "Deleted"} note={<span className="tabular-nums">{q.data.length}</span>}>
            <Table data-testid="deletions">
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>{state === "pending" ? "Deletes" : "Was due"}</TableHead>
                  <TableHead>Asked</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.map((d) => {
                  const st = deletionState(d);
                  return (
                    <TableRow key={d.uid} data-testid={`deletion-${d.uid}`}>
                      <TableCell>
                        <Link to={paths.account(d.uid)} className="font-mono text-link hover:underline">
                          {d.uid}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular-nums">{dateTime(d.delete_after)}</TableCell>
                      <TableCell className="text-xs">
                        {dateTime(d.requested_at)}
                        {d.source ? ` · ${words(d.source)}` : ""}
                      </TableCell>
                      <TableCell>
                        <Badge variant={st.tone}>{st.label}</Badge>
                      </TableCell>
                      <TableCell className="text-xs whitespace-normal">
                        {d.blocked
                          ? `${d.blocked_reason ? words(d.blocked_reason) : "blocked"}${typeof d.attempts === "number" ? ` · ${d.attempts} attempts` : ""}${d.next_attempt_at ? ` · next ${dateTime(d.next_attempt_at)}` : ""}`
                          : d.cancelled_at
                            ? `${dateTime(d.cancelled_at)}${d.cancelled_by ? ` · ${d.cancelled_by}` : ""}`
                            : d.processed_at
                              ? `${dateTime(d.processed_at)}${d.processed_by ? ` · ${d.processed_by}` : ""}${d.outcome ? ` · ${words(d.outcome)}` : ""}`
                              : ""}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Panel>
        ))}
    </>
  );
}
