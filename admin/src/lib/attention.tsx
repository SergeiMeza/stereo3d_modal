import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { alertFrom, type DisputeAlert } from "../components/DisputesAlert";
import { buildLanes, type LaneItem } from "./lanes";
import { useServices } from "./services";
import type { CasesResponse, DisputeSummary, FeedbackItem } from "./types";

/**
 * What's waiting, for the nav badges and the Overview (BL-29 redesign B):
 * the open cases, the disputes summary and the last week's feedback,
 * refreshed every 60 s and when the window gets focus. Errors stay quiet:
 * a badge just doesn't show.
 */

export const ATTENTION_POLL_MS = 60_000;

export interface Attention {
  cases: CasesResponse | null;
  disputes: DisputeSummary | null;
  alert: DisputeAlert | null;
  lanes: LaneItem[];
  /** open cases whose refund failed (reason refund_failed) */
  failedRefunds: number;
  feedback: FeedbackItem[] | null;
  /** feedback since the console last opened Feedback (the gateway's marker) */
  feedbackNew: number;
  updatedAt: number | null;
  refresh: () => void;
  markFeedbackSeen: () => void;
}

const AttentionContext = createContext<Attention | null>(null);

export function useAttention(): Attention {
  const v = useContext(AttentionContext);
  if (!v) throw new Error("useAttention outside AttentionProvider");
  return v;
}

export function AttentionProvider({ children }: { children: ReactNode }) {
  const { api } = useServices();
  const [cases, setCases] = useState<CasesResponse | null>(null);
  const [disputes, setDisputes] = useState<DisputeSummary | null>(null);
  const [feedback, setFeedback] = useState<FeedbackItem[] | null>(null);
  /** the gateway's "seen up to" marker: 0 when never set, null while unknown */
  const [seen, setSeen] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    await Promise.all([
      api.listCases({ tab: "open" }).then(setCases, () => {}),
      // quiet: the Disputes page shows the error when it's opened
      api.disputes(3).then(setDisputes, () => {}),
      api.feedback(7, "").then((f) => setFeedback(f.items ?? []), () => {}),
      // never move the marker back (a mark made while this was in flight wins)
      api.feedbackSeen().then((m) => {
        const at = m.seen_at ? Date.parse(m.seen_at) || 0 : 0;
        setSeen((cur) => Math.max(cur ?? 0, at));
      }, () => {}),
    ]);
    setUpdatedAt(Date.now());
  }, [api]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), ATTENTION_POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const markFeedbackSeen = useCallback(() => {
    const now = new Date();
    setSeen(now.getTime());
    api.setFeedbackSeen(now.toISOString()).catch(() => {
      // quiet: the badge comes back on the next poll
    });
  }, [api]);

  const value = useMemo<Attention>(() => {
    const rows = cases?.cases ?? [];
    return {
      cases,
      disputes,
      alert: disputes ? alertFrom(disputes) : null,
      lanes: cases || disputes ? buildLanes(rows, disputes) : [],
      failedRefunds: rows.filter((r) => r.reason === "refund_failed").length,
      feedback,
      feedbackNew: seen === null ? 0 : (feedback ?? []).filter((f) => Date.parse(f.created_at) > seen).length,
      updatedAt,
      refresh: () => void load(),
      markFeedbackSeen,
    };
  }, [cases, disputes, feedback, seen, updatedAt, load, markFeedbackSeen]);

  return <AttentionContext.Provider value={value}>{children}</AttentionContext.Provider>;
}
