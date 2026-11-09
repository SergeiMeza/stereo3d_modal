"use client";

/**
 * The 3D depth control (owner 2026-11-10): Comfortable · Standard · Strong
 * on Lifelike's Make 3D and preview, with one line under it. The pick is
 * the project's (useMake3dChoice "depth"), so the preview and Make 3D show
 * the same one.
 */

import { useId } from "react";
import type { JSX } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { LifelikeDepth } from "@/lib/api/types";
import { DEPTH_CHOICES, depthHint, depthLabel, depthName, isDepthChoice } from "@/lib/depthChoice";
import { useT } from "@/lib/i18n/I18nProvider";

export function DepthChoice({
  value,
  onChange,
  compact = false,
}: {
  value: LifelikeDepth;
  onChange: (d: LifelikeDepth) => void;
  /** the preview's smaller type */
  compact?: boolean;
}): JSX.Element {
  const t = useT();
  const labelId = useId();
  return (
    <div data-testid="depth-choice" className="flex min-w-0 flex-col gap-1">
      <span id={labelId} className={compact ? "text-[11px] text-fg-muted" : "text-sm font-medium text-fg"}>
        {depthLabel(t)}
      </span>
      <ToggleGroup
        type="single"
        value={value}
        // a tap on the chosen one would clear it: keep it
        onValueChange={(v) => {
          if (isDepthChoice(v)) onChange(v);
        }}
        aria-labelledby={labelId}
      >
        {DEPTH_CHOICES.map((d) => (
          <ToggleGroupItem key={d} value={d} data-testid={`depth-${d}`} className={compact ? undefined : "text-sm"}>
            {depthName(d, t)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className={compact ? "text-[11px] text-fg-muted" : "text-xs text-fg-muted"}>{depthHint(t)}</p>
    </div>
  );
}
