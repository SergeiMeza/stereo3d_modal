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

import { useT } from "@/lib/i18n/I18nProvider";
import { rich } from "@/lib/i18n/rich";
import type { Tr } from "@/lib/i18n/t";

import { tabLabel, WORKSPACE_TABS, type TabDef } from "./PageTabs";

interface Shortcut {
  keys: string[];
  action: string;
}

const pageGroup = (tabs: readonly TabDef[], t: Tr) => ({
  title: t("workspace.shortcuts.pages.title"),
  shortcuts: tabs.map((tab, i) => ({
    keys: [String(i + 1)],
    action: t("workspace.shortcuts.pages.page", { page: tabLabel(tab.id, t) }),
  })),
});

const otherGroups = (t: Tr): readonly { title: string; shortcuts: Shortcut[] }[] => [
  {
    title: t("workspace.shortcuts.playback.title"),
    shortcuts: [
      { keys: [t("workspace.shortcuts.keys.space")], action: t("workspace.shortcuts.playback.playPause") },
      { keys: ["←", "→"], action: t("workspace.shortcuts.playback.stepFrame") },
      { keys: ["Shift", "←/→"], action: t("workspace.shortcuts.playback.stepSecond") },
    ],
  },
  {
    title: t("workspace.shortcuts.scenes.title"),
    shortcuts: [
      { keys: [t("workspace.shortcuts.keys.click")], action: t("workspace.shortcuts.scenes.scrub") },
      { keys: [t("workspace.shortcuts.keys.doubleClick")], action: t("workspace.shortcuts.scenes.addCut") },
      { keys: [t("workspace.shortcuts.keys.drag")], action: t("workspace.shortcuts.scenes.moveCut") },
      { keys: ["Del", "⌫"], action: t("workspace.shortcuts.scenes.removeCut") },
      { keys: ["⌘/Ctrl", t("workspace.shortcuts.keys.scroll")], action: t("workspace.shortcuts.scenes.zoom") },
    ],
  },
  {
    title: t("workspace.shortcuts.help.title"),
    shortcuts: [{ keys: ["?"], action: t("workspace.shortcuts.help.toggle") }],
  },
];

export interface ShortcutsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project's rail (number keys follow it); default Classic. */
  tabs?: readonly TabDef[];
}

export function ShortcutsSheet({
  open,
  onOpenChange,
  tabs = WORKSPACE_TABS,
}: ShortcutsSheetProps): JSX.Element {
  const t = useT();
  const groups = [pageGroup(tabs, t), ...otherGroups(t)];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shortcuts-sheet" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("workspace.shortcuts.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-5 sm:grid-cols-2">
          {groups.map((g) => (
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
          {rich(t, "workspace.shortcuts.footer", { kbd: (c) => <kbd>{c}</kbd> })}
        </p>
      </DialogContent>
    </Dialog>
  );
}
