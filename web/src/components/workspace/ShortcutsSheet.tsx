"use client";

/**
 * Keyboard-shortcuts cheat sheet — a shadcn Dialog toggled with "?" (or the
 * header button). Esc / backdrop / × close via Radix; open state is owned
 * by WorkspaceScreen.
 */

import type { JSX } from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { WORKSPACE_TABS } from "./PageTabs";

interface Shortcut {
  keys: string[];
  action: string;
}

const GROUPS: readonly { title: string; shortcuts: Shortcut[] }[] = [
  {
    title: "Pages",
    shortcuts: WORKSPACE_TABS.map((t, i) => ({
      keys: [String(i + 1)],
      action: `${t.label} page`,
    })),
  },
  {
    title: "Playback (Media & Cut pages)",
    shortcuts: [
      { keys: ["Space"], action: "Play / pause the preview" },
      { keys: ["←", "→"], action: "Step exactly ±1 frame" },
      { keys: ["Shift", "←/→"], action: "Step ±1 second" },
    ],
  },
  {
    title: "Players (Depth & Stereo pages)",
    shortcuts: [
      { keys: ["Space"], action: "Play / pause the output player" },
    ],
  },
  {
    title: "Scene cuts (Cut page)",
    shortcuts: [
      { keys: ["Click"], action: "Scrub the filmstrip" },
      { keys: ["2×Click"], action: "Add a cut at the cursor frame" },
      { keys: ["Drag"], action: "Move a cut marker (snaps to frames)" },
      { keys: ["Del"], action: "Remove the selected cut" },
      { keys: ["⌘/Ctrl", "Scroll"], action: "Zoom the timeline at the playhead" },
    ],
  },
  {
    title: "Help",
    shortcuts: [{ keys: ["?"], action: "Toggle this sheet" }],
  },
];

export interface ShortcutsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutsSheet({
  open,
  onOpenChange,
}: ShortcutsSheetProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shortcuts-sheet" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="grid gap-5 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
                {g.title}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {g.shortcuts.map((s) => (
                  <li
                    key={s.action}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="text-fg-muted">{s.action}</span>
                    <span className="flex shrink-0 gap-1">
                      {s.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="text-[11px] text-fg-muted">
          Shortcuts are ignored while typing in a field. Press <kbd>Esc</kbd>{" "}
          to close.
        </p>
      </DialogContent>
    </Dialog>
  );
}
