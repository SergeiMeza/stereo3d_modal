import type { JSX } from "react";

import { Badge } from "@/components/ui/badge";
import type { ConversionState } from "@/lib/api/types";

const STYLES: Record<ConversionState, string> = {
  created: "border-edge bg-surface-2 text-fg-muted",
  paid: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  processing: "border-primary/30 bg-primary/10 text-primary",
  succeeded: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-300",
  canceled: "border-edge bg-surface-2 text-fg-muted",
  expired: "border-amber-500/30 bg-amber-500/10 text-amber-300",
};

export function StateChip({ state }: { state: ConversionState }): JSX.Element {
  return (
    <Badge variant="outline" className={STYLES[state]}>
      {state}
    </Badge>
  );
}
