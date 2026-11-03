"use client";

/**
 * Left page rail, DaVinci Resolve-style: one tab per pipeline stage,
 * vertically centered, icon over label, switchable with the number keys
 * (the keydown handler lives in WorkspaceScreen). The set follows the
 * project's method, in plain words (S3D-26): Lifelike Overview · Scenes ·
 * Preview · Make 3D · Files; Classic Overview · Scenes · Depth · 3D look ·
 * Make 3D · Files. Old URL slugs (media, cut, stereo, deliver, history)
 * still open their page. Pure presentation: tabs + active id in, onChange
 * out.
 */

import type { JSX } from "react";

import type { Method } from "@/lib/api/types";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type WorkspaceTabId =
  | "overview"
  | "scenes"
  | "depth"
  | "look"
  | "preview"
  | "make"
  | "files";

/** Slugs from before the rename (links, bookmarks) → today's page. */
const LEGACY_SLUGS: Record<string, WorkspaceTabId> = {
  media: "overview",
  cut: "scenes",
  stereo: "look",
  deliver: "make",
  history: "files",
};

export interface TabDef {
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

const ALL_TABS: readonly TabDef[] = [
  {
    id: "overview",
    label: "Overview",
    hint: "Your video, what you'll get, the price and the next step",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M8 4v5M16 4v5" />
      </svg>
    ),
  },
  {
    id: "scenes",
    label: "Scenes",
    hint: "Check where each scene starts — free",
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
    hint: "Optional: preview how far away everything is",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <path d="M12 3 3 8l9 5 9-5-9-5Z" />
        <path d="m3 12.5 9 5 9-5M3 17l9 5 9-5" />
      </svg>
    ),
  },
  {
    id: "look",
    label: "3D look",
    hint: "Optional: adjust the 3D per scene and preview a moment",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <circle cx="7" cy="13" r="3.5" />
        <circle cx="17" cy="13" r="3.5" />
        <path d="M10.5 13c.5-1 2.5-1 3 0M3.5 12 2 7h20l-1.5 5" />
      </svg>
    ),
  },
  {
    id: "preview",
    label: "Preview",
    hint: "See a few seconds in 3D from any moment",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="m10 8.5 5 3.5-5 3.5v-7Z" />
      </svg>
    ),
  },
  {
    id: "make",
    label: "Make 3D",
    hint: "Make the whole video (or a part) in 3D",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <path d="M12 15V4m0 0 4 4m-4-4L8 8" />
        <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
      </svg>
    ),
  },
  {
    id: "files",
    label: "Files",
    hint: "Your 3D files, how to watch them, and what each run cost",
    icon: (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </svg>
    ),
  },
];

const TAB_IDS: Record<Method, readonly WorkspaceTabId[]> = {
  classic: ["overview", "scenes", "depth", "look", "make", "files"],
  lifelike: ["overview", "scenes", "preview", "make", "files"],
};

/** The rail for a project's method, in order. */
export function tabsFor(method: Method): readonly TabDef[] {
  return TAB_IDS[method].map((id) => ALL_TABS.find((t) => t.id === id)!);
}

/** Tab ids for a method, in rail (and number-key) order. */
export function tabOrderFor(method: Method): readonly WorkspaceTabId[] {
  return TAB_IDS[method];
}

/** The Classic rail (today's tabs, unchanged). */
export const WORKSPACE_TABS: readonly TabDef[] = tabsFor("classic");

export const TAB_ORDER: readonly WorkspaceTabId[] = TAB_IDS.classic;

/** Any tab id either method knows (URL hashes are parsed before the
 * project — and its method — has loaded). */
export function isWorkspaceTabId(v: unknown): v is WorkspaceTabId {
  return (
    typeof v === "string" && ALL_TABS.some((t) => t.id === (v as string))
  );
}

/** A URL slug → its page: today's ids and the legacy ones. */
export function tabFromSlug(slug: string): WorkspaceTabId | null {
  if (isWorkspaceTabId(slug)) return slug;
  return LEGACY_SLUGS[slug] ?? null;
}

/** A tab id from a link or the other method's rail, mapped onto this
 * method's rail: Classic's Depth/3D look pages become Lifelike's Preview
 * and back. */
export function tabForMethod(tab: WorkspaceTabId, method: Method): WorkspaceTabId {
  if (TAB_IDS[method].includes(tab)) return tab;
  if (method === "lifelike") return "preview"; // depth | look
  return "look"; // preview
}

export interface PageTabsProps {
  /** The rail to show (tabsFor(method)); default: the Classic rail. */
  tabs?: readonly TabDef[];
  active: WorkspaceTabId;
  onChange: (tab: WorkspaceTabId) => void;
  /** Tabs unavailable right now, mapped to the human reason (shown as the
   * tooltip in place of the hint). A locked tab renders disabled — clicks
   * are ignored; the number-key shortcut is guarded in WorkspaceScreen. */
  locked?: Partial<Record<WorkspaceTabId, string>>;
}

export function PageTabs({
  tabs = WORKSPACE_TABS,
  active,
  onChange,
  locked = {},
}: PageTabsProps): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Workspace pages"
      className="flex shrink-0 flex-col items-stretch justify-center gap-1 border-r border-edge bg-surface-1 py-4"
    >
      {tabs.map((tab, i) => {
        const selected = tab.id === active;
        const lockReason = locked[tab.id];
        return (
          <Tooltip key={tab.id}>
            <TooltipTrigger asChild>
              {/* Locked tabs stay aria-disabled (NOT disabled) so the
                  explanatory tooltip still fires; the click is a no-op. */}
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                aria-disabled={lockReason !== undefined || undefined}
                data-testid={`tab-${tab.id}`}
                onClick={() => {
                  if (lockReason === undefined) onChange(tab.id);
                }}
                className={`relative flex w-16 flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${
                  selected
                    ? "text-primary"
                    : lockReason !== undefined
                      ? "cursor-not-allowed text-fg-muted/40"
                      : "text-fg-muted hover:text-fg"
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
              {lockReason ?? (
                <>
                  {tab.hint}
                  <kbd>{i + 1}</kbd>
                </>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
