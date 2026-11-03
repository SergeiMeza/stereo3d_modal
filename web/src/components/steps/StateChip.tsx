import type { JSX } from "react";

import { Badge } from "@/components/ui/badge";
import type { Conversion } from "@/lib/api/types";

import { runStatus, type RunTone } from "./runStatus";

const STYLES: Record<RunTone, string> = {
  waiting: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  working: "border-primary/30 bg-primary/10 text-primary",
  ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  attention: "border-red-500/30 bg-red-500/10 text-red-300",
  stopped: "border-edge bg-surface-2 text-fg-muted",
};

/** A run's state in customer words (runStatus). */
export function StateChip({
  conversion,
}: {
  conversion: Conversion;
}): JSX.Element {
  const s = runStatus(conversion);
  return (
    <Badge
      variant="outline"
      data-testid="run-status"
      className={STYLES[s.tone]}
    >
      {s.label}
    </Badge>
  );
}
