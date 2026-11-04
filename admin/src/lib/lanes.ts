import { dateOnly, money, time, until, words } from "./format";
import { typeLabel } from "./labels";
import { paths } from "./router";
import type { CaseRow, DisputeSummary } from "./types";

/**
 * The Overview's lanes (BL-29 redesign B): what needs the owner now, today
 * and this week, built from the open cases (GET /v1/admin/cases?tab=open)
 * and the disputes summary. Red = overdue or money at risk, amber = due
 * today, grey = later this week.
 */

export type Lane = "now" | "today" | "week";

export interface LaneItem {
  key: string;
  lane: Lane;
  /** what it is: "Early fraud warning", "Refund failed", "Dispute: evidence due" */
  what: string;
  /** CASE-… or the dispute id when there is no case */
  id: string;
  caseId?: string;
  who: string;
  cents: number | null;
  /** the deadline as shown: "6 h overdue", "17:00", "Nov 9" */
  due: string;
  at: number | null;
  kind: "efw" | "refund_failed" | "dispute" | "overdue" | "case";
  href: string;
}

const HOUR = 3600e3;
const WEEK = 7 * 24 * HOUR;

function endOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function laneFor(at: number | null, risk: boolean, now: number): Lane | null {
  if (risk) return "now";
  if (at === null) return null;
  if (at < now) return "now";
  if (at <= endOfDay(now)) return "today";
  if (at <= now + WEEK) return "week";
  return null;
}

function dueLabel(at: number | null, lane: Lane, now: number): string {
  if (at === null) return "now";
  if (at < now) return until(new Date(at).toISOString(), now);
  if (lane === "today") return time(new Date(at).toISOString());
  return dateOnly(new Date(at).toISOString()).replace(/, \d{4}$/, "");
}

function caseWhat(r: CaseRow): { what: string; kind: LaneItem["kind"] } {
  if (r.type === "efw") return { what: "Early fraud warning", kind: "efw" };
  if (r.reason === "refund_failed") return { what: "Refund failed", kind: "refund_failed" };
  if (r.type === "dispute" || r.dispute_due) return { what: "Dispute: evidence due", kind: "dispute" };
  const label = r.type === "refund" ? "Refund request" : typeLabel(r.type);
  return { what: r.reason ? `${label} · ${words(r.reason)}` : label, kind: "case" };
}

export function buildLanes(cases: CaseRow[], summary: DisputeSummary | null, now = Date.now()): LaneItem[] {
  const out: LaneItem[] = [];
  const seen = new Set<string>();
  for (const r of cases) {
    const { what, kind } = caseWhat(r);
    const dueIso = r.dispute_due || r.deadline_at || null;
    const at = dueIso ? Date.parse(dueIso) : null;
    const disputeSoon = kind === "dispute" && at !== null && at - now <= 24 * HOUR;
    const risk = kind === "efw" || kind === "refund_failed" || !!r.deadline_red || disputeSoon;
    const lane = laneFor(at, risk, now);
    if (!lane) continue;
    seen.add(r.id);
    out.push({
      key: r.id,
      lane,
      what,
      id: r.id,
      caseId: r.id,
      who: r.email_masked || "—",
      cents: r.max_refundable_cents ?? r.requested_cents ?? null,
      due: dueLabel(at, lane, now),
      at,
      kind: at !== null && at < now && kind === "case" ? "overdue" : kind,
      href: paths.case(r.id),
    });
  }
  for (const d of summary?.open ?? []) {
    if (d.case_id && seen.has(d.case_id)) continue;
    const at = d.due_by ? Date.parse(d.due_by) : null;
    const lane = laneFor(at, at !== null && at - now <= 24 * HOUR, now);
    if (!lane) continue;
    out.push({
      key: d.dispute_id,
      lane,
      what: `Dispute: evidence due · ${words(d.reason)}`,
      id: d.case_id || d.dispute_id,
      caseId: d.case_id,
      who: d.case_id ? "" : "no case",
      cents: d.amount_cents,
      due: dueLabel(at, lane, now),
      at,
      kind: "dispute",
      href: d.case_id ? paths.case(d.case_id) : paths.disputes(),
    });
  }
  const order: Record<Lane, number> = { now: 0, today: 1, week: 2 };
  return out.sort((a, b) => order[a.lane] - order[b.lane] || (a.at ?? 0) - (b.at ?? 0));
}

/** What the Next up card says about an item. */
export function nextUpCopy(item: LaneItem): { title: string; body: string } {
  const amount = item.cents !== null ? money(item.cents) : "";
  switch (item.kind) {
    case "efw":
      return {
        title: `Early fraud warning${amount ? ` on ${amount}` : ""}`,
        body: "The card was reported as fraudulent. Refunding now usually stops it becoming a dispute that counts against the rate.",
      };
    case "refund_failed":
      return {
        title: `A refund${amount ? ` of ${amount}` : ""} failed`,
        body: "The money didn't go back. Retry it, or mark it refunded outside Stripe once it's paid another way.",
      };
    case "dispute":
      return {
        title: `Dispute${amount ? ` on ${amount}` : ""}: evidence due ${item.due}`,
        body: "Counter it in the Stripe Dashboard with the evidence, or accept it. A lost dispute counts against the rate.",
      };
    case "overdue":
      return { title: `${item.what}${amount ? ` · ${amount}` : ""}`, body: `Past its deadline (${item.due}). The customer is waiting for a decision.` };
    default:
      return { title: `${item.what}${amount ? ` · ${amount}` : ""}`, body: `Due ${item.due}.` };
  }
}
