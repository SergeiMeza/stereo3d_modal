"use client";

/**
 * Source details on Overview (owner 2026-11-07): the uploaded video's
 * facts, folded away by default, styled like Files → Details and with the
 * same formatters. Only what the gateway reports, never an estimate; rows
 * it has no data for are left out. The open state is the viewer's own
 * (remembered in this browser).
 *
 * Today's fields: the file size, the probe (resolution, frame rate with
 * VFR, frames, duration, the video's bitrate), the dynamic range while HDR
 * output is on, and the black bars. The gateway adds the rest (file name,
 * container, codec, colour, rotation, audio, camera); each becomes one row
 * in sourceRows when it does.
 */

import { atomWithStorage } from "jotai/utils";
import { ChevronDown } from "lucide-react";
import { Collapsible } from "radix-ui";
import type { JSX, ReactNode } from "react";

import { DETAIL_LIST_CLASS, DetailItem } from "@/components/steps/RunDetails";
import { fpsLabel } from "@/components/steps/frameRate";
import type { Project } from "@/lib/api/types";
import { barSides, removesBars } from "@/lib/bars";
import { formatBytes, formatVideoLength } from "@/lib/format";
import { resolutionName } from "@/lib/glossary";
import { safeJSONStorage } from "@/lib/state/safeStorage";
import { useAppAtom } from "@/lib/state/stores";

import { parseCrop } from "./utils";

/** Folded or open, per viewer, for every project (localStorage). */
export const sourceDetailsOpenAtom = atomWithStorage<boolean>(
  "svs:overview:source-details-open",
  false,
  safeJSONStorage<boolean>(),
  { getOnInit: true },
);

const RANGE: Record<string, string> = {
  sdr: "SDR",
  hlg: "HDR (HLG)",
  pq: "HDR (PQ)",
  dv_8: "Dolby Vision",
  dv_5: "Dolby Vision",
};

export interface SourceRow {
  label: string;
  value: ReactNode;
}

/** The rows the project has data for, in reading order. */
export function sourceRows(project: Project): SourceRow[] {
  const rows: SourceRow[] = [];
  const add = (label: string, value: ReactNode | null | undefined | false) => {
    if (value !== null && value !== undefined && value !== false && value !== "") rows.push({ label, value });
  };
  const p = project.probe;

  // the file
  add("Size", project.source_bytes > 0 ? formatBytes(project.source_bytes) : null);
  add("Length", p && p.duration_s > 0 ? formatVideoLength(p.duration_s) : null);

  // the picture
  add("Resolution", p ? `${p.width}×${p.height} · ${resolutionName(p)}` : null);
  if (p) {
    const counted = p.counted_frames && p.duration_s > 0 ? p.counted_frames / p.duration_s : null;
    add(
      "Frame rate",
      p.vfr && counted !== null
        ? `${fpsLabel(p.fps)} · variable, up to ${fpsLabel(counted)}`
        : p.vfr
          ? `${fpsLabel(p.fps)} · variable`
          : fpsLabel(p.fps),
    );
    add("Frames", p.num_frames > 0 ? p.num_frames.toLocaleString("en-US") : null);
    add("Video bitrate", p.bit_rate && p.bit_rate > 0 ? `${Math.round(p.bit_rate / 1e6)} Mbit/s` : null);
  }
  add("Dynamic range", project.dynamic_range ? (RANGE[project.dynamic_range] ?? project.dynamic_range.toUpperCase()) : null);

  // the frame
  if (project.has_bars === true && barSides(project) !== null) {
    const c = parseCrop(project.crop);
    add(
      "Black bars",
      [
        "Detected",
        c ? `picture ${c.width}×${c.height}` : null,
        removesBars(project) ? "removed in your 3D" : "kept in your 3D",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  } else if (project.has_bars === false) {
    add("Black bars", "None");
  }
  return rows;
}

export function SourceDetails({ project }: { project: Project }): JSX.Element | null {
  const [open, setOpen] = useAppAtom(sourceDetailsOpenAtom);
  const rows = sourceRows(project);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Source details" className="min-w-0">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger
          data-testid="source-details-toggle"
          className="group inline-flex items-center gap-1 text-sm font-semibold text-fg hover:text-fg"
        >
          Source details
          <ChevronDown aria-hidden className="size-4 text-fg-muted transition-transform group-data-[state=open]:rotate-180" />
        </Collapsible.Trigger>
        {/* rendered only while open, like Run details */}
        {open ? (
          <Collapsible.Content data-testid="source-details" className="mt-2">
            <dl className={DETAIL_LIST_CLASS}>
              {rows.map((r) => (
                <DetailItem key={r.label} label={r.label}>
                  {r.value}
                </DetailItem>
              ))}
            </dl>
          </Collapsible.Content>
        ) : null}
      </Collapsible.Root>
    </section>
  );
}
