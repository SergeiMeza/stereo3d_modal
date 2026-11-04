import { useState } from "react";

import { ErrorState, PageHeader, Panel, SkeletonRows, StateBox } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldControl, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "@/lib/api";
import { dateOnly } from "@/lib/format";
import { Link, paths, useRouter } from "@/lib/router";
import { useServices } from "@/lib/services";
import type { Tone } from "@/components/common";
import { useLoad } from "@/lib/useLoad";
import { GRANT_STATUS, label } from "./Grants";

/**
 * Grants (Money): every Grant Pro grant across accounts, active first
 * (GET /v1/admin/grants, gateway rev 00114). Granting and revoking happen
 * on the account page.
 */
export function GrantsPage() {
  const { api } = useServices();
  const { navigate } = useRouter();
  const { state, retry } = useLoad(() => api.allGrants(), [api]);
  const [uid, setUid] = useState("");
  return (
    <>
      <PageHeader title="Grants">
        <span className="text-sm text-muted-foreground">
          Admin grants only (Grant Pro): plans bought at Checkout or in the App Store aren't listed here.
        </span>
      </PageHeader>
      {state.kind === "loading" && <SkeletonRows rows={5} cols={6} />}
      {state.kind === "error" && <ErrorState title="Couldn't load the grants." message={errorMessage(state.error)} onRetry={retry} />}
      {state.kind === "loaded" &&
        (state.data.length === 0 ? (
          <StateBox title="No grants yet.">Grant Pro, Business or Studio from an account page.</StateBox>
        ) : (
          <Panel title="All grants" note={<span className="tabular-nums">{state.data.length}</span>}>
            <Table data-testid="all-grants">
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>End</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data.map((g) => {
                  const st = GRANT_STATUS[g.status as keyof typeof GRANT_STATUS] ?? { label: label(g.status), tone: "plain" as Tone };
                  return (
                    <TableRow key={g.id} data-testid={`all-grant-${g.id}`}>
                      <TableCell>
                        <Link to={paths.account(g.uid)} className="text-link hover:underline">{g.email || g.uid}</Link>
                      </TableCell>
                      <TableCell>{label(g.kind)}</TableCell>
                      <TableCell className="tabular-nums">{dateOnly(g.start)}</TableCell>
                      <TableCell className="tabular-nums">{dateOnly(g.end)}</TableCell>
                      <TableCell>
                        <Badge variant={st.tone}>{st.label}</Badge>
                        {g.revoke_reason && (
                          <div className="text-xs text-muted-foreground">
                            {g.revoked_by ? `${g.revoked_by}: ` : ""}
                            {g.revoke_reason}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{g.granted_by}</TableCell>
                      <TableCell className="max-w-80 text-xs whitespace-normal">{g.reason}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Panel>
        ))}
      <Panel title="Grant on an account">
        <form
          className="flex flex-wrap items-end gap-2 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (uid.trim()) navigate(paths.account(uid.trim()));
          }}
        >
          <Field className="max-w-90">
            <FieldLabel>Firebase UID</FieldLabel>
            <FieldControl>
              <Input value={uid} onChange={(e) => setUid(e.target.value)} />
            </FieldControl>
            <FieldDescription>Or press ⌘K and search by email.</FieldDescription>
          </Field>
          <Button type="submit" variant="default" disabled={!uid.trim()}>
            Open the account
          </Button>
        </form>
      </Panel>
    </>
  );
}
