"use client";

/**
 * Shared transport controls (speed + mute) for every player, in the same
 * visual system as the workspace PreviewViewer transport: outline xs
 * ui/button shapes, text-xs muted labels. Native <select>s only — tests
 * inspect .options (see controls.tsx).
 */

import { Volume2, VolumeX } from "lucide-react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/I18nProvider";
import { blurAfterMouseClick } from "@/lib/interactions";

import { selectClass } from "./controls";

/** The ONE audio mute toggle, sitting next to SpeedSelect on every
 * transport (workspace viewer and step output players). Videos start MUTED
 * (autoplay policy — the element keeps its initial `muted` attribute);
 * unmuting here is a user gesture, so browsers allow it. In a compare pair
 * only the MASTER gets sound — the follower must stay muted. */
export function MuteToggle({
  muted,
  onChange,
  disabled,
}: {
  muted: boolean;
  onChange: (muted: boolean) => void;
  disabled?: boolean;
}): JSX.Element {
  const t = useT();
  return (
    <Button
      variant="outline"
      size="icon-xs"
      aria-label={muted ? t("preview.player.unmute") : t("preview.player.mute")}
      disabled={disabled}
      onClick={(e) => {
        blurAfterMouseClick(e);
        onChange(!muted);
      }}
    >
      {muted ? <VolumeX /> : <Volume2 />}
    </Button>
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
  const t = useT();
  return (
    <label className="flex items-center gap-1 text-xs text-fg-muted">
      {t("preview.player.speed")}
      <select
        id={id}
        aria-label={t("preview.player.speed")}
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
