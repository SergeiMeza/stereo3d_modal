import { useAtomValue } from "jotai";

import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/components/common";
import { liveAdminRunAtom } from "../lib/liveRuns";
import { words } from "../lib/format";

export function runTone(status: string): Tone {
  const s = status.toUpperCase();
  if (s === "SUCCEEDED") return "green";
  if (s === "FAILED" || s === "CANCELLED" || s === "CANCELED") return "amber";
  return "plain";
}

/** A run's status as the stream last said it, with its progress while
 * it's being made ("processing · 62%", "waiting for a GPU"). */
export function LiveRunStatus({ id, status }: { id: string; status: string }) {
  const live = useAtomValue(liveAdminRunAtom(id));
  const state = live?.state ?? status;
  const working = state.toLowerCase() === "processing";
  const pct = working && typeof live?.progress === "number" ? Math.round(Math.min(Math.max(live.progress, 0), 1) * 100) : null;
  return (
    <span className="inline-flex items-center gap-2" data-testid={`run-status-${id}`}>
      <Badge variant={runTone(state)}>{words(state).toLowerCase()}</Badge>
      {working && live?.waiting_for_gpu ? (
        <span className="text-xs text-muted-foreground">waiting for a GPU</span>
      ) : pct !== null ? (
        <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
      ) : null}
    </span>
  );
}

