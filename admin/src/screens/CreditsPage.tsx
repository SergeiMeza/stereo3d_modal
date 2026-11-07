import { ErrorState, PageHeader, Panel, SkeletonRows, StateBox, type Tone } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "@/lib/api";
import { dateOnly, dateTime, money } from "@/lib/format";
import { Link, paths } from "@/lib/router";
import { allCreditGrantsQuery } from "@/state/queries";
import { useQuery } from "@/state/query";
import { CREDIT_STATE, reasonLabel } from "./CreditGrants";

/**
 * Credits (Money, owner 2026-11-07, gateway 00178): every credit grant
 * across accounts, newest first, with the monthly totals (granted and
 * revoked). Granting and revoking happen on the account page.
 */
function monthName(m: string): string {
  return new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function CreditsPage() {
  const { state, retry } = useQuery(allCreditGrantsQuery, null);
  return (
    <>
      <PageHeader title="Credits">
        <span className="text-sm text-muted-foreground">Usage credit granted by us. Plan and Pro credit aren't listed here.</span>
      </PageHeader>
      {state.kind === "loading" && <SkeletonRows rows={5} cols={6} />}
      {state.kind === "error" && <ErrorState title="Couldn't load the credit grants." message={errorMessage(state.error)} onRetry={retry} />}
      {state.kind === "loaded" &&
        (state.data.grants.length === 0 ? (
          <StateBox title="No credit granted yet.">Grant credit from an account page.</StateBox>
        ) : (
          <>
            <Panel title="By month" note="granted and revoked">
              <Table data-testid="credit-months">
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead numeric>Grants</TableHead>
                    <TableHead numeric>Granted</TableHead>
                    <TableHead numeric>Revoked</TableHead>
                    <TableHead numeric>Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.data.months.map((m) => (
                    <TableRow key={m.month} data-testid={`credit-month-${m.month}`}>
                      <TableCell>{monthName(m.month)}</TableCell>
                      <TableCell numeric>{m.grants}</TableCell>
                      <TableCell numeric>{money(m.cents)}</TableCell>
                      <TableCell numeric>{m.revoked_cents ? `−${money(m.revoked_cents)}` : money(0)}</TableCell>
                      <TableCell numeric>{money(m.cents - m.revoked_cents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
            <Panel title="All credit grants" note={<span className="tabular-nums">{state.data.grants.length}</span>}>
              <Table data-testid="all-credit-grants">
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead numeric>Amount</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Ends</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Granted</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.data.grants.map((g) => {
                    const st = CREDIT_STATE[g.state] ?? { label: g.state, tone: "plain" as Tone };
                    return (
                      <TableRow key={g.id} data-testid={`all-credit-${g.id}`}>
                        <TableCell>
                          {g.uid ? (
                            <Link to={paths.account(g.uid)} className="font-mono text-xs text-link hover:underline">{g.uid}</Link>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell numeric>{money(g.amount_cents)}</TableCell>
                        <TableCell>
                          <Badge variant={st.tone}>{st.label}</Badge>
                          {g.state === "revoked" && g.revoked_cents ? (
                            <div className="text-xs text-muted-foreground">{money(g.revoked_cents)} removed</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="max-w-72 text-xs whitespace-normal">{reasonLabel(g)}</TableCell>
                        <TableCell className="text-xs">{g.expires_at ? dateOnly(g.expires_at) : "No end"}</TableCell>
                        <TableCell className="text-xs">{g.admin ?? "—"}</TableCell>
                        <TableCell className="text-xs">{dateTime(g.created_at)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {state.data.truncated && <p className="px-4 py-2 text-xs text-muted-foreground">The newest 500 grants; the months count those.</p>}
            </Panel>
          </>
        ))}
    </>
  );
}
