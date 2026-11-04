import { useState } from "react";

import { ErrorState, SkeletonRows } from "../components/ui";
import { errorMessage } from "../lib/api";
import { pct } from "../lib/format";
import { useServices } from "../lib/services";
import type { OnboardingHeadsets } from "../lib/types";
import { useLoad } from "../lib/useLoad";

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

const name = (d: string) => DEVICE_NAMES[d] ?? d;

/** Onboarding: where new people watch (owner 2026-11-04) — answers by
 * device over time, by plan, and each device's conversion rate. */
export function OnboardingPanel() {
  const { api } = useServices();
  const [days, setDays] = useState(90);
  const { state, retry } = useLoad(() => api.onboardingHeadsets(days), [api, days]);
  return (
    <>
      <div className="titlebar">
        <h1>Onboarding</h1>
        <span className="muted small">Where new people watch · from the welcome&apos;s first question</span>
        <span className="grow" />
        <select className="fsel" aria-label="Days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 12 months</option>
        </select>
      </div>
      {state.kind === "loading" && <SkeletonRows rows={4} cols={4} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the onboarding answers." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && <Headsets data={state.data} />}
    </>
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
      <div className="stats card">
        <div className="stat"><div className="stat-v">{people}</div><div className="stat-l">device answers</div><div className="stat-s">{data.days} days</div></div>
        <div className="stat"><div className="stat-v">{pct(people ? converted / people : 0, 0)}</div><div className="stat-l">converted</div><div className="stat-s">{converted} of {people}</div></div>
      </div>

      <section className="card">
        <div className="sh"><b>Conversion by device</b><span className="xs muted">paid for a full 3D run after answering</span></div>
        <div className="scroll-x">
          <table className="at" data-testid="onboarding-conversion">
            <thead><tr><th>Device</th><th className="num">People</th><th className="num">Converted</th><th className="num">Rate</th></tr></thead>
            <tbody>
              {conv.map((c) => (
                <tr key={c.device}>
                  <td>{name(c.device)}</td>
                  <td className="num">{c.people}</td>
                  <td className="num">{c.converted}</td>
                  <td className="num">{pct(c.people ? c.converted / c.people : 0, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two even">
        <section className="card">
          <div className="sh"><b>Answers by device over time</b><span className="xs muted">per week</span></div>
          <div className="scroll-x">
            <table className="at" data-testid="onboarding-weeks">
              <thead><tr><th>Device</th>{weeks.map((w) => <th key={w} className="num xs">{w.slice(5)}</th>)}</tr></thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d}>
                    <td>{name(d)}</td>
                    {weeks.map((w) => {
                      const v = cell(d, w);
                      return (
                        <td key={w} className="num" title={`${v}`}>
                          <span className="spark" style={{ height: `${Math.max(2, (v / max) * 24)}px` }} aria-hidden />
                          <span className="xs">{v || ""}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <div className="sh"><b>By plan</b><span className="xs muted">plan when they answered</span></div>
          <div className="scroll-x">
            <table className="at" data-testid="onboarding-plans">
              <thead><tr><th>Device</th>{plans.map((p) => <th key={p} className="num">{PLAN_NAMES[p] ?? p}</th>)}</tr></thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d}>
                    <td>{name(d)}</td>
                    {plans.map((p) => (
                      <td key={p} className="num">{byPlan.filter((r) => r.device === d && r.plan === p).reduce((s, r) => s + r.count, 0)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
