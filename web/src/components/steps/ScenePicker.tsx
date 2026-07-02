"use client";

/**
 * Transport controls for the step output players: a NATIVE scene <select>
 * ("Whole video" + one option per scene, labels from useScenePlayback) with
 * ‹ / › steppers, and a playback-speed <select> (same option set — and the
 * same visual system: outline xs ui/button shapes, text-xs muted labels —
 * as the workspace PreviewViewer transport). Native <select>s only — tests
 * inspect .options (see controls.tsx).
 */

import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { blurAfterMouseClick } from "@/lib/interactions";

import { selectClass } from "./controls";
import type { ScenePlayback } from "./useScenePlayback";

export function ScenePicker({
  id,
  playback,
}: {
  /** id for the <select> (unique per page, e.g. "depth-scene"). */
  id: string;
  playback: ScenePlayback;
}): JSX.Element | null {
  const { scenes, selected } = playback;
  if (scenes.length === 0) return null;
  return (
    <div data-testid={`${id}-picker`} className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="icon-xs"
        aria-label="Previous scene"
        disabled={selected === null}
        onClick={(e) => {
          blurAfterMouseClick(e);
          playback.prevScene();
        }}
      >
        ‹
      </Button>
      <select
        id={id}
        aria-label="Scene to play"
        value={selected === null ? "" : selected.index}
        onChange={(e) =>
          playback.selectScene(
            e.target.value === "" ? null : Number(e.target.value),
          )
        }
        className={`${selectClass} py-1 text-xs`}
      >
        <option value="">Whole video</option>
        {scenes.map((s) => (
          <option key={s.first} value={s.index}>
            {s.label}
          </option>
        ))}
      </select>
      <Button
        variant="outline"
        size="icon-xs"
        aria-label="Next scene"
        disabled={selected !== null && selected.index >= scenes.length - 1}
        onClick={(e) => {
          blurAfterMouseClick(e);
          playback.nextScene();
        }}
      >
        ›
      </Button>
    </div>
  );
}

/** Playback rates offered on every player (workspace viewer included). */
export const SPEED_CHOICES = [0.25, 0.5, 1, 1.5, 2] as const;

/** Native playback-speed picker with its muted "Speed" label — the ONE
 * speed control, reused by the workspace PreviewViewer and the step output
 * players. The OWNER applies the rate to its video element(s) — in a
 * compare pair master AND follower must share the rate, or the
 * fraction-sync fights the transport. */
export function SpeedSelect({
  id,
  value,
  onChange,
}: {
  /** id for the <select> (unique per page, e.g. "depth-speed"). */
  id: string;
  value: number;
  onChange: (rate: number) => void;
}): JSX.Element {
  return (
    <label className="flex items-center gap-1 text-xs text-fg-muted">
      Speed
      <select
        id={id}
        aria-label="Speed"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${selectClass} py-1 text-xs`}
      >
        {SPEED_CHOICES.map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
    </label>
  );
}
