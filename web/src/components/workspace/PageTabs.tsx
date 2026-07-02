"use client";

/**
 * Left page rail, DaVinci Resolve-style: one tab per pipeline stage,
 * vertically centered, icon over label, switchable with the number keys
 * (1–6 — the keydown handler lives in WorkspaceScreen). Pure presentation:
 * active id in, onChange out.
 */

import type { JSX } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type WorkspaceTabId =
  | "media"
  | "cut"
  | "depth"
  | "stereo"
  | "deliver"
  | "history";

interface TabDef {
  id: WorkspaceTabId;
  label: string;
  /** One-line tooltip; the shortcut key is appended automatically. */
  hint: string;
  icon: JSX.Element;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const WORKSPACE_TABS: readonly TabDef[] = [
  {
    id: "media",
    label: "Media",
    hint: "Source video, analysis results & pipeline guide",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M8 4v5M16 4v5" />
      </svg>
    ),
  },
  {
    id: "cut",
    label: "Cut",
    hint: "Review & edit scene cuts on the frame-exact timeline",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <circle cx="6" cy="7" r="2.5" />
        <circle cx="6" cy="17" r="2.5" />
        <path d="M8.2 8.5 20 18M8.2 15.5 20 6" />
      </svg>
    ),
  },
  {
    id: "depth",
    label: "Depth",
    hint: "Depth — define the depth map: resolution is the cost/quality knob",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <path d="M12 3 3 8l9 5 9-5-9-5Z" />
        <path d="m3 12.5 9 5 9-5M3 17l9 5 9-5" />
      </svg>
    ),
  },
  {
    id: "stereo",
    label: "Stereo",
    hint: "Stereo — per-scene 3D strength & shot type, splatted or inpainted",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <circle cx="7" cy="13" r="3.5" />
        <circle cx="17" cy="13" r="3.5" />
        <path d="M10.5 13c.5-1 2.5-1 3 0M3.5 12 2 7h20l-1.5 5" />
      </svg>
    ),
  },
  {
    id: "deliver",
    label: "Deliver",
    hint: "Production — full-quality conversion & final formats",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <path d="M12 15V4m0 0 4 4m-4-4L8 8" />
        <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
      </svg>
    ),
  },
  {
    id: "history",
    label: "History",
    hint: "Every conversion of this project — states, prices, downloads",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </svg>
    ),
  },
];

export const TAB_ORDER: readonly WorkspaceTabId[] = WORKSPACE_TABS.map(
  (t) => t.id,
);

export function isWorkspaceTabId(v: unknown): v is WorkspaceTabId {
  return typeof v === "string" && TAB_ORDER.includes(v as WorkspaceTabId);
}

export interface PageTabsProps {
  active: WorkspaceTabId;
  onChange: (tab: WorkspaceTabId) => void;
}

export function PageTabs({ active, onChange }: PageTabsProps): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Workspace pages"
      className="flex shrink-0 flex-col items-stretch justify-center gap-1 border-r border-edge bg-surface-1 py-4"
    >
      {WORKSPACE_TABS.map((tab, i) => {
        const selected = tab.id === active;
        return (
          <Tooltip key={tab.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`tab-${tab.id}`}
                onClick={() => onChange(tab.id)}
                className={`relative flex w-16 flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${
                  selected ? "text-primary" : "text-fg-muted hover:text-fg"
                }`}
              >
                {/* active indicator, Resolve-style thin bar on the tab edge */}
                <span
                  aria-hidden
                  className={`absolute inset-y-2 left-0 w-0.5 rounded-r ${
                    selected ? "bg-primary" : "bg-transparent"
                  }`}
                />
                {tab.icon}
                {tab.label}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="flex items-center gap-1.5">
              {tab.hint}
              <kbd>{i + 1}</kbd>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
