import { atom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo } from "react";

import { createQuery, dataOf } from "@/state/query";
import { apiOf, servicesAtom } from "@/state/services";
import { alertFrom, type DisputeAlert } from "../components/DisputesAlert";
import { buildLanes, type LaneItem } from "./lanes";
import type { CasesResponse, DisputeSummary, FeedbackItem } from "./types";

/**
 * What's waiting, for the nav badges and the Overview (BL-29), in atoms
 * (ADR 0138): the open cases, the disputes summary, the last week's
 * feedback and the console's feedback "seen" marker, refreshed every 60 s
 * and when the window gets focus. A failed refresh keeps the last data
 * (errors stay quiet: a badge just doesn't change).
 */

export const ATTENTION_POLL_MS = 60_000;

export const openCasesQuery = createQuery<null, CasesResponse>((get) => apiOf(get(servicesAtom)).listCases({ tab: "open" }));
export const disputesAlertQuery = createQuery<null, DisputeSummary>((get) => apiOf(get(servicesAtom)).disputes(3));
export const weekFeedbackQuery = createQuery<null, FeedbackItem[]>(async (get) => (await apiOf(get(servicesAtom)).feedback(7, "")).items ?? []);
const feedbackSeenQuery = createQuery<null, number>(async (get) => {
  const m = await apiOf(get(servicesAtom)).feedbackSeen();
  return m.seen_at ? Date.parse(m.seen_at) || 0 : 0;
});

/** When the last refresh finished (null before the first). */
export const attentionUpdatedAtom = atom<number | null>(null);
/** Opening Feedback here: never moved back by a refresh in flight. */
const seenLocallyAtom = atom(0);

export const refreshAttentionAtom = atom(null, async (_get, set) => {
  const quiet = () => undefined;
  await Promise.all([
    set(openCasesQuery.run, null, "keep").catch(quiet),
    set(disputesAlertQuery.run, null, "keep").catch(quiet),
    set(weekFeedbackQuery.run, null, "keep").catch(quiet),
    set(feedbackSeenQuery.run, null, "keep").catch(quiet),
  ]);
  set(attentionUpdatedAtom, Date.now());
});

export const markFeedbackSeenAtom = atom(null, (get, set) => {
  const now = new Date();
  set(seenLocallyAtom, now.getTime());
  apiOf(get(servicesAtom))
    .setFeedbackSeen(now.toISOString())
    .catch(() => {
      // quiet: the badge comes back on the next poll
    });
});

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
}

export const attentionAtom = atom<Attention>((get) => {
  const cases = dataOf(get(openCasesQuery.value(null))) ?? null;
  const disputes = dataOf(get(disputesAlertQuery.value(null))) ?? null;
  const feedback = dataOf(get(weekFeedbackQuery.value(null))) ?? null;
  const serverSeen = dataOf(get(feedbackSeenQuery.value(null)));
  const local = get(seenLocallyAtom);
  const seen = serverSeen === undefined && !local ? null : Math.max(serverSeen ?? 0, local);
  const rows = cases?.cases ?? [];
  return {
    cases,
    disputes,
    alert: disputes ? alertFrom(disputes) : null,
    lanes: cases || disputes ? buildLanes(rows, disputes) : [],
    failedRefunds: rows.filter((r) => r.reason === "refund_failed").length,
    feedback,
    feedbackNew: seen === null ? 0 : (feedback ?? []).filter((f) => Date.parse(f.created_at) > seen).length,
    updatedAt: get(attentionUpdatedAtom),
  };
});

export function useAttention(): Attention & { refresh: () => void; markFeedbackSeen: () => void } {
  const a = useAtomValue(attentionAtom);
  const refresh = useSetAtom(refreshAttentionAtom);
  const markFeedbackSeen = useSetAtom(markFeedbackSeenAtom);
  return useMemo(() => ({ ...a, refresh: () => void refresh(), markFeedbackSeen }), [a, refresh, markFeedbackSeen]);
}

/** Polls the attention atoms while the shell is mounted. */
export function useAttentionPolling() {
  const refresh = useSetAtom(refreshAttentionAtom);
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), ATTENTION_POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
}
