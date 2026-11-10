"use client";

/**
 * On /vision-pro, a visitor who isn't in Vision Pro Safari is told the
 * samples play in 3D only there. The server renders nothing (it can't
 * tell), and the client decides on hydration.
 */

import { useSyncExternalStore } from "react";
import type { JSX } from "react";

import { detectClient } from "@/lib/headset";

/** The browser never changes under the page. */
const noChanges = (): (() => void) => () => {};

export function NotVisionProNote({
  text,
}: {
  text: string;
}): JSX.Element | null {
  const show = useSyncExternalStore(
    noChanges,
    () => detectClient() !== "vision",
    () => false,
  );
  if (!show) return null;
  return (
    <p
      data-testid="not-vision-pro"
      role="note"
      className="rounded-xl border border-edge bg-card p-4 text-sm text-fg-muted"
    >
      {text}
    </p>
  );
}
