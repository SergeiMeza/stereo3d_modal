import { useState } from "react";

import type { ReactNode } from "react";

import { EmptyRow, ErrorState, FilterSelect, PageHeader, Panel, SkeletonRows } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "../lib/api";
import { pct } from "../lib/format";
import type { OnboardingHeadsets } from "../lib/types";
import { useQuery } from "@/state/query";
import { businessFunnelQuery, onboardingQuery } from "@/state/queries";

/** The welcome's device names. The web app sends Make 3D's device ids
 * (WELCOME_DEVICES: avp, quest, galaxyxr, pico, steamframe, glasses, tv,
 * unsure); the gateway stores any slug, so a few spelled-out aliases are
 * named too. */
const DEVICE_NAMES: Record<string, string> = {
  vision_pro: "Apple Vision Pro",
  galaxy_xr: "Samsung Galaxy XR",
  steam_frame: "Steam Frame",
  avp: "Apple Vision Pro",
  quest: "Meta Quest",
  galaxyxr: "Samsung Galaxy XR",
  pico: "Pico",
  steamframe: "Steam Frame",
  glasses: "XR glasses",
  tv: "3D TV or projector",
  unsure: "Not sure yet",
};

const PLAN_NAMES: Record<string, string> = { none: "No plan", pro: "Pro", business: "Business", studio: "Studio" };

const VARIANT_NAMES: Record<string, string> = { default: "Web welcome", app_pro: "App Pro welcome" };

const name = (d: string) => DEVICE_NAMES[d] ?? d;

/** Onboarding: where new people watch (owner 2026-11-04) — answers by
 * device over time, by plan, and each device's conversion rate. */
export function OnboardingPanel() {
  const [days, setDays] = useState(90);
  const { state, retry } = useQuery(onboardingQuery, days);
  return (
    <>
      <PageHeader
        title="Onboarding"
        actions={
          <FilterSelect
            label="Days"
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            options={[
              { value: "30", label: "Last 30 days" },
              { value: "90", label: "Last 90 days" },
              { value: "365", label: "Last 12 months" },
            ]}
          />
        }
      >
        <span className="text-sm text-muted-foreground">Where new people watch · from the welcome&apos;s first question</span>
      </PageHeader>
      {state.kind === "loading" && <SkeletonRows rows={4} cols={4} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the onboarding answers." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && <Headsets data={state.data} />}
      {state.kind === "loaded" && <SetupAnswers days={days} />}
    </>
  );
}

const MAIN_USES: Record<string, string> = {
  client_work: "Client work",
  own_channel: "Own channel",
  stock: "Stock footage",
  other: "Other",
};

/** What the Business/Studio setup asked: main use and team size. Loaded on
 * its own; a failure leaves the rest of the page alone. */
function SetupAnswers({ days }: { days: number }) {
  const { state } = useQuery(businessFunnelQuery, days);
  if (state.kind !== "loaded") return null;
  const a = state.data.answers;
  const uses = a?.by_main_use ?? [];
  const sizes = a?.by_team_size ?? [];
  if (!a || (uses.length === 0 && sizes.length === 0)) return null;
  const total = (rows: { count: number }[]) => rows.reduce((s, r) => s + r.count, 0) || 1;
  return (
    <div className={TWO} data-testid="onboarding-setup-answers">
      <Panel title="Main use" note={`Business and Studio setup · ${a.accounts} accounts`}>
        <Table>
          <TableBody>
            {[...uses].sort((x, y) => y.count - x.count).map((r) => (
              <TableRow key={r.main_use}>
                <TableCell>{MAIN_USES[r.main_use] ?? r.main_use}</TableCell>
                <TableCell numeric>{r.count}</TableCell>
                <TableCell numeric>{pct(r.count / total(uses), 0)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
      <Panel title="Team size" note="as answered">
        <Table>
          <TableBody>
            {[...sizes].sort((x, y) => y.count - x.count).map((r) => (
              <TableRow key={r.team_size}>
                <TableCell>{r.team_size}</TableCell>
                <TableCell numeric>{r.count}</TableCell>
                <TableCell numeric>{pct(r.count / total(sizes), 0)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </div>
  );
}

function Headsets({ data }: { data: OnboardingHeadsets }) {
  const byDay = data.by_day ?? [];
  const byPlan = data.by_plan ?? [];
  const conv = [...(data.conversion ?? [])].sort((a, b) => b.people - a.people);
  const devices = [...new Set([...conv.map((c) => c.device), ...byDay.map((r) => r.device)])];
  // by week, so a quarter fits on one row of bars per device
  const weekOf = (day: string) => {
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const weeks = [...new Set(byDay.map((r) => weekOf(r.day)))].sort();
  const cell = (device: string, week: string) =>
    byDay.filter((r) => r.device === device && weekOf(r.day) === week).reduce((s, r) => s + r.count, 0);
  const max = Math.max(1, ...devices.flatMap((d) => weeks.map((w) => cell(d, w))));
  const plans = [...new Set(byPlan.map((r) => r.plan))];
  const people = conv.reduce((s, c) => s + c.people, 0);
  const converted = conv.reduce((s, c) => s + c.converted, 0);

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <Stat value={String(people)} label="device answers" sub={`${data.days} days`} />
        <Stat value={pct(people ? converted / people : 0, 0)} label="converted" sub={`${converted} of ${people}`} />
      </div>

      <Panel title="Conversion by device" note="paid for a full 3D run after answering">
        {conv.length === 0 && <EmptyRow>No device answers in this window.</EmptyRow>}
          <Table data-testid="onboarding-conversion">
            <TableHeader><TableRow><TableHead>Device</TableHead><TableHead numeric>People</TableHead><TableHead numeric>Converted</TableHead><TableHead numeric>Rate</TableHead></TableRow></TableHeader>
            <TableBody>
              {conv.map((c) => (
                <TableRow key={c.device}>
                  <TableCell>{name(c.device)}</TableCell>
                  <TableCell numeric>{c.people}</TableCell>
                  <TableCell numeric>{c.converted}</TableCell>
                  <TableCell numeric>{pct(c.people ? c.converted / c.people : 0, 0)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
      </Panel>

      <div className={TWO}>
        <Panel title="Answers by device over time" note="per week">
            <Table data-testid="onboarding-weeks">
              <TableHeader><TableRow><TableHead>Device</TableHead>{weeks.map((w) => <TableHead key={w} numeric className="text-2xs">{w.slice(5)}</TableHead>)}</TableRow></TableHeader>
              <TableBody>
                {devices.map((d) => (
                  <TableRow key={d}>
                    <TableCell>{name(d)}</TableCell>
                    {weeks.map((w) => {
                      const v = cell(d, w);
                      return (
                        <TableCell key={w} numeric title={`${v}`}>
                          {/* React sets the height through CSSOM, which the CSP allows */}
                          <span
                            className="mr-1 inline-block w-1.5 rounded-[2px] bg-primary/70 align-bottom"
                            style={{ height: `${Math.max(2, (v / max) * 24)}px` }}
                            aria-hidden
                          />
                          <span className="text-xs">{v || ""}</span>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
        </Panel>
        <Panel title="By plan" note="plan when they answered">
            <Table data-testid="onboarding-plans">
              <TableHeader><TableRow><TableHead>Device</TableHead>{plans.map((p) => <TableHead key={p} numeric>{PLAN_NAMES[p] ?? p}</TableHead>)}</TableRow></TableHeader>
              <TableBody>
                {devices.map((d) => (
                  <TableRow key={d}>
                    <TableCell>{name(d)}</TableCell>
                    {plans.map((p) => (
                      <TableCell key={p} numeric>{byPlan.filter((r) => r.device === d && r.plan === p).reduce((s, r) => s + r.count, 0)}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
        </Panel>
      </div>

      <ByVariant rows={data.by_variant ?? []} />
      <SetupFunnel rows={data.business_setup ?? []} />
    </>
  );
}

const SETUP_STEPS: { id: string; label: string }[] = [
  { id: "opened", label: "Opened the setup" },
  { id: "plan_picked", label: "Picked a plan" },
  { id: "details_done", label: "Company details done" },
  { id: "checkout_started", label: "Started checkout" },
  { id: "purchased", label: "Bought" },
];

/** Business/Studio setup: people per step and the share of those who
 * opened it. */
function SetupFunnel({ rows }: { rows: NonNullable<OnboardingHeadsets["business_setup"]> }) {
  if (rows.length === 0) return null;
  const at = (id: string) => rows.find((r) => r.step === id || r.step === `business_setup_${id}`);
  const opened = at("opened")?.people ?? 0;
  return (
    <Panel title="Business and Studio setup" note="people per step">
        <Table data-testid="onboarding-setup-funnel">
          <TableHeader><TableRow><TableHead>Step</TableHead><TableHead numeric>People</TableHead><TableHead numeric>Of opened</TableHead><TableHead numeric>Business</TableHead><TableHead numeric>Studio</TableHead></TableRow></TableHeader>
          <TableBody>
            {SETUP_STEPS.map((s) => {
              const r = at(s.id);
              const n = r?.people ?? 0;
              return (
                <TableRow key={s.id}>
                  <TableCell>{s.label}</TableCell>
                  <TableCell numeric>{n}</TableCell>
                  <TableCell numeric>{pct(opened ? n / opened : 0, 0)}</TableCell>
                  <TableCell numeric>{r?.by_plan?.business ?? "—"}</TableCell>
                  <TableCell numeric>{r?.by_plan?.studio ?? "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
    </Panel>
  );
}

/** The welcome variants side by side: answers per device, and how many
 * converted when the gateway says. */
function ByVariant({ rows }: { rows: NonNullable<OnboardingHeadsets["by_variant"]> }) {
  if (rows.length === 0) return null;
  const variants = [...new Set(rows.map((r) => r.variant))].sort();
  const devices = [...new Set(rows.map((r) => r.device))];
  const sum = (v: string, d?: string, f: "count" | "converted" = "count") =>
    rows.filter((r) => r.variant === v && (d === undefined || r.device === d)).reduce((s, r) => s + (r[f] ?? 0), 0);
  const hasConv = rows.some((r) => typeof r.converted === "number");
  return (
    <Panel title="By welcome" note="web welcome or app Pro welcome">
        <Table data-testid="onboarding-variants">
          <TableHeader><TableRow><TableHead>Device</TableHead>{variants.map((v) => <TableHead key={v} numeric>{VARIANT_NAMES[v] ?? v}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {devices.map((d) => (
              <TableRow key={d}>
                <TableCell>{name(d)}</TableCell>
                {variants.map((v) => <TableCell key={v} numeric>{sum(v, d)}</TableCell>)}
              </TableRow>
            ))}
            <TableRow>
              <TableCell><b className="font-semibold">All answers</b></TableCell>
              {variants.map((v) => <TableCell key={v} numeric><b>{sum(v)}</b></TableCell>)}
            </TableRow>
            {hasConv ? (
              <TableRow>
                <TableCell>Converted</TableCell>
                {variants.map((v) => {
                  const n = sum(v);
                  const c = sum(v, undefined, "converted");
                  return <TableCell key={v} numeric>{c} · {pct(n ? c / n : 0, 0)}</TableCell>;
                })}
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
    </Panel>
  );
}

const TWO = "grid grid-cols-2 items-start gap-4 max-[1000px]:grid-cols-1";

function Stat({ value, label, sub }: { value: string; label: string; sub?: ReactNode }) {
  return (
    <div className="border-r border-border p-4 last:border-r-0">
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="text-sm text-foreground-2">{label}</div>
      {sub && <div className="text-2xs text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  );
}
