import { EmptyRow, Panel, type Tone } from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateOnly, dateTime, money, words } from "../lib/format";
import type { ProCreditAdmin, ProCreditGrant } from "../lib/types";

/**
 * Pro credit (gateway 00159, PRO-07): the usage credit Pro gets, one row
 * per grant the gateway made, newest first, with its state; a removed
 * grant says how much was taken back and when. Above the table, the repeat-refunder flag: the account refunded
 * Pro twice or more (the gateway alerts on it too). Read only.
 */

export const PRO_CREDIT_STATE: Record<ProCreditGrant["state"], { label: string; tone: Tone }> = {
  granting: { label: "Granting", tone: "blue" },
  granted: { label: "Granted", tone: "green" },
  removed: { label: "Removed", tone: "amber" },
};

const KIND: Record<string, string> = {
  pro_weekly: "Pro Weekly",
  pro_monthly: "Pro Monthly",
  pro_yearly: "Pro Yearly",
  pro_3m: "Pro 3 months",
  pro_6m: "Pro 6 months",
  pro_pass_3m: "Pro pass, 3 months",
  pro_pass_6m: "Pro pass, 6 months",
  pro_lifetime: "Pro Lifetime",
};

const SOURCE: Record<string, string> = {
  app_store: "App Store",
  mac_app_store: "Mac App Store",
  rc_billing: "RevenueCat billing",
  web: "Web",
};

export function proKind(kind: string): string {
  return KIND[kind] ?? words(kind);
}

export function ProCreditSection({ credit }: { credit: ProCreditAdmin | null | undefined }) {
  if (!credit) return null;
  const grants = [...(credit.grants ?? [])].sort((a, b) => (a.period_start < b.period_start ? 1 : -1));
  const refunds = credit.refunds ?? 0;
  return (
    <Panel
      title="Pro credit"
      note={`usage credit with Pro · ${refunds} Pro ${refunds === 1 ? "refund" : "refunds"}`}
      data-testid="pro-credit"
    >
      {credit.refund_flag ? (
        <Alert variant="red" data-testid="pro-refund-flag" className="mb-3">
          <AlertDescription>
            Repeat refunder: this account refunded Pro {refunds} times. A refund takes back the credit still left.
          </AlertDescription>
        </Alert>
      ) : null}
      {grants.length === 0 ? (
        <EmptyRow>No Pro credit granted.</EmptyRow>
      ) : (
        <Table data-testid="pro-credit-table">
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead>Pro</TableHead>
              <TableHead>Source</TableHead>
              <TableHead numeric>Credit</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Granted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.map((g) => {
              const st = PRO_CREDIT_STATE[g.state] ?? { label: words(g.state), tone: "plain" as Tone };
              return (
                <TableRow key={g.id} data-testid={`pro-credit-${g.id}`}>
                  <TableCell>
                    {dateOnly(g.period_start)} – {dateOnly(g.period_end)}
                  </TableCell>
                  <TableCell>
                    {proKind(g.kind)}
                    {g.period_type === "trial" ? <span className="text-muted-foreground"> · trial</span> : null}
                  </TableCell>
                  <TableCell>{SOURCE[g.source] ?? words(g.source)}</TableCell>
                  <TableCell numeric>{money(g.cents)}</TableCell>
                  <TableCell>
                    <Badge variant={st.tone}>{st.label}</Badge>
                    {g.state === "removed" ? (
                      <div className="text-xs text-muted-foreground">
                        {typeof g.removed_cents === "number" ? `${money(g.removed_cents)} taken back` : "taken back"}
                        {g.removed_at ? ` · ${dateOnly(g.removed_at)}` : ""}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">{dateTime(g.granted_at)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
