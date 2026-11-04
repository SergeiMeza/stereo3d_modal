import { useState } from "react";

import { ErrorState, SkeletonRows } from "../components/ui";
import { errorMessage } from "../lib/api";
import { pct } from "../lib/format";
import { useServices } from "../lib/services";
import type { PlansSurfaces } from "../lib/types";
import { useLoad } from "../lib/useLoad";

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
  const { api } = useServices();
  const [days, setDays] = useState(30);
  const { state, retry } = useLoad(() => api.plansSurfaces(days), [api, days]);
  return (
    <>
      <div className="titlebar">
        <h1>Plans surfaces</h1>
        <span className="muted small">Views, dismissals, clicks and plan starts per placement · last click within 7 days</span>
        <span className="grow" />
        <select className="fsel" aria-label="Days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {state.kind === "loading" && <SkeletonRows rows={6} cols={6} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the plans surfaces." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && <Table data={state.data} />}
    </>
  );
}

function Table({ data }: { data: PlansSurfaces }) {
  const rows = [...(data.placements ?? [])].sort((a, b) => b.views - a.views);
  return (
    <>
      <section className="card">
        <div className="scroll-x">
          <table className="at" data-testid="plans-surfaces">
            <thead>
              <tr>
                <th>Placement</th>
                <th className="num">Views</th>
                <th className="num">People</th>
                <th className="num">Dismissed</th>
                <th className="num">Clicks</th>
                <th className="num">Click rate</th>
                <th className="num">Plan starts</th>
                <th className="num">Start rate</th>
                <th>By plan</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.placement}>
                  <td>{NAMES[r.placement] ?? r.placement}</td>
                  <td className="num">{r.views}</td>
                  <td className="num">{r.viewers}</td>
                  <td className="num">{r.dismissals}</td>
                  <td className="num">{r.clicks}</td>
                  <td className="num">{pct(r.click_rate, 1)}</td>
                  <td className="num">{r.conversions}</td>
                  <td className="num">{pct(r.conversion_rate, 1)}</td>
                  <td className="xs muted">{products(r.conversions_by_product)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="muted small pad">
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
    <section className="card">
      <div className="sh"><b>By reason</b><span className="xs muted">why a Business surface showed</span></div>
      <div className="scroll-x">
        <table className="at" data-testid="plans-surfaces-reasons">
          <thead>
            <tr>
              <th>Placement</th>
              <th>Reason</th>
              <th className="num">Views</th>
              <th className="num">Dismissed</th>
              <th className="num">Clicks</th>
              <th className="num">Click rate</th>
              <th className="num">Plan starts</th>
              <th>By plan</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={`${r.placement}:${r.reason}`}>
                <td>{NAMES[r.placement] ?? r.placement}</td>
                <td>{REASONS[r.reason] ?? r.reason}</td>
                <td className="num">{r.views}</td>
                <td className="num">{r.dismissals}</td>
                <td className="num">{r.clicks}</td>
                <td className="num">{pct(r.click_rate ?? (r.views ? r.clicks / r.views : 0), 1)}</td>
                <td className="num">{r.conversions}</td>
                <td className="xs muted">{products(r.conversions_by_product ?? {})}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
