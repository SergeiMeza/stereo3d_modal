import { useState } from "react";

import { EmptyRow, ErrorState, FilterSelect, PageHeader, Panel, SkeletonRows } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "../lib/api";
import { pct } from "../lib/format";
import type { PlansSurfaces } from "../lib/types";
import { useQuery } from "@/state/query";
import { plansSurfacesQuery } from "@/state/queries";

const NAMES: Record<string, string> = {
  header: "Header · Plans and Save chip",
  projects_banner: "Projects banner",
  quote: "Quote · pay once or with Pro",
  receipt: "Receipt · you'd have saved",
  plans_sheet: "Plans sheet after a preview",
  business_note: "Business note in large quotes",
  business_banner: "Talk to us banner",
  plans_hint: "Plans page hint",
};

const REASONS: Record<string, string> = {
  source_8k: "Source above 4K",
  source_fps: "Source above 30 fps",
  quote_size: "Quote $50 or more",
  run_length: "Run over 10 min",
  company_email: "Company email",
};

const products = (by: Partial<Record<string, number>>) =>
  (["pro", "business", "studio"] as const)
    .filter((k) => (by[k] ?? 0) > 0)
    .map((k) => `${k === "pro" ? "Pro" : k === "business" ? "Business" : "Studio"} ${by[k]}`)
    .join(" · ");

/** Plans surfaces (owner 2026-11-04): each placement's views, dismissals,
 * clicks and the plan starts its last click led to (7-day window). */
export function PlansSurfacesPanel() {
  const [days, setDays] = useState(30);
  const { state, retry } = useQuery(plansSurfacesQuery, days);
  return (
    <>
      <PageHeader
        title="Plans surfaces"
        actions={
          <FilterSelect
            label="Days"
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            options={[
              { value: "7", label: "Last 7 days" },
              { value: "30", label: "Last 30 days" },
              { value: "90", label: "Last 90 days" },
            ]}
          />
        }
      >
        <span className="text-sm text-muted-foreground">Views, dismissals, clicks and plan starts per placement · last click within 7 days</span>
      </PageHeader>
      {state.kind === "loading" && <SkeletonRows rows={6} cols={6} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the plans surfaces." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && <Placements data={state.data} />}
    </>
  );
}

function Placements({ data }: { data: PlansSurfaces }) {
  const rows = [...(data.placements ?? [])].sort((a, b) => b.views - a.views);
  return (
    <>
      <Panel>
        {rows.length === 0 && <EmptyRow>No placement was shown in this window.</EmptyRow>}
          <Table data-testid="plans-surfaces">
            <TableHeader>
              <TableRow>
                <TableHead>Placement</TableHead>
                <TableHead numeric>Views</TableHead>
                <TableHead numeric>People</TableHead>
                <TableHead numeric>Dismissed</TableHead>
                <TableHead numeric>Clicks</TableHead>
                <TableHead numeric>Click rate</TableHead>
                <TableHead numeric>Plan starts</TableHead>
                <TableHead numeric>Start rate</TableHead>
                <TableHead>By plan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.placement}>
                  <TableCell>{NAMES[r.placement] ?? r.placement}</TableCell>
                  <TableCell numeric>{r.views}</TableCell>
                  <TableCell numeric>{r.viewers}</TableCell>
                  <TableCell numeric>{r.dismissals}</TableCell>
                  <TableCell numeric>{r.clicks}</TableCell>
                  <TableCell numeric>{pct(r.click_rate, 1)}</TableCell>
                  <TableCell numeric>{r.conversions}</TableCell>
                  <TableCell numeric>{pct(r.conversion_rate, 1)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{products(r.conversions_by_product)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
      </Panel>
      <p className="px-4 text-sm text-muted-foreground">
        Plan starts with no click in the 7 days before: {data.unattributed.conversions}
        {products(data.unattributed.by_product) ? ` (${products(data.unattributed.by_product)})` : ""}.
      </p>
      <ByReason rows={data.by_reason ?? []} />
    </>
  );
}

/** Business guidance by why it showed (owner 2026-11-04). */
function ByReason({ rows }: { rows: NonNullable<PlansSurfaces["by_reason"]> }) {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => b.views - a.views);
  return (
    <Panel title="By reason" note="why a Business surface showed">
        <Table data-testid="plans-surfaces-reasons">
          <TableHeader>
            <TableRow>
              <TableHead>Placement</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead numeric>Views</TableHead>
              <TableHead numeric>Dismissed</TableHead>
              <TableHead numeric>Clicks</TableHead>
              <TableHead numeric>Click rate</TableHead>
              <TableHead numeric>Plan starts</TableHead>
              <TableHead>By plan</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => (
              <TableRow key={`${r.placement}:${r.reason}`}>
                <TableCell>{NAMES[r.placement] ?? r.placement}</TableCell>
                <TableCell>{REASONS[r.reason] ?? r.reason}</TableCell>
                <TableCell numeric>{r.views}</TableCell>
                <TableCell numeric>{r.dismissals}</TableCell>
                <TableCell numeric>{r.clicks}</TableCell>
                <TableCell numeric>{pct(r.click_rate ?? (r.views ? r.clicks / r.views : 0), 1)}</TableCell>
                <TableCell numeric>{r.conversions}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{products(r.conversions_by_product ?? {})}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
    </Panel>
  );
}
