"use client";

/**
 * In China mode the samples CDN can't be reached (lib/samples.ts,
 * sampleMediaBlocked): wherever one of its files would play, preview or
 * download, this line stands in for the player or the button. The sample
 * project stays for everyone (owner 2026-11-08); posters and thumbnails
 * on the web's own origin still show.
 */

import type { JSX } from "react";

import { useT } from "@/lib/i18n/I18nProvider";
import { sampleMediaBlocked } from "@/lib/samples";
import { useRegion } from "@/lib/useRegion";

/** Whether any of these URLs is a samples-CDN file this visitor can't
 * load (re-renders when the region changes). */
export function useSampleBlocked(...urls: (string | null | undefined)[]): boolean {
  const region = useRegion();
  return urls.some((u) => sampleMediaBlocked(u, region));
}

export function SampleRegionNotice({ className }: { className?: string }): JSX.Element {
  const t = useT();
  return (
    <p
      data-testid="sample-region-notice"
      role="note"
      className={className ?? "text-xs text-fg-muted"}
    >
      {t("files.load.sampleRegion")}
    </p>
  );
}
