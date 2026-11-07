"use client";

/**
 * Source details on Overview (owner 2026-11-07): the uploaded video's
 * facts, folded away by default, styled like Files → Details and with the
 * same formatters. Only what the gateway reports, never an estimate; rows
 * it has no data for are left out. The open state is the viewer's own
 * (remembered in this browser).
 *
 * The rows come from project.source_details (gateway 00175: the file, the
 * video with its codec, bit depth, colour and rotation, the audio, a 3D
 * source and the camera), the probe where an older project has no
 * details, and the black bars.
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

const CODEC: Record<string, string> = {
  hevc: "HEVC (H.265)",
  h265: "HEVC (H.265)",
  h264: "H.264",
  avc: "H.264",
  prores: "ProRes",
  av1: "AV1",
  vp9: "VP9",
  vp8: "VP8",
  mpeg4: "MPEG-4",
  aac: "AAC",
  alac: "ALAC",
  ac3: "Dolby Digital",
  eac3: "Dolby Digital Plus",
  opus: "Opus",
  mp3: "MP3",
  pcm_s16le: "PCM",
  pcm_s24le: "PCM",
};

const TRANSFER: Record<string, string> = {
  bt709: "SDR",
  "bt470bg": "SDR",
  smpte170m: "SDR",
  smpte2084: "HDR (PQ)",
  "arib-std-b67": "HDR (HLG)",
};

const PRIMARIES: Record<string, string> = {
  bt709: "BT.709",
  bt2020: "BT.2020",
  smpte432: "Display P3",
  smpte431: "DCI-P3",
  bt470bg: "BT.601",
  smpte170m: "BT.601",
};

const STEREO: Record<string, string> = {
  mvhevc: "Spatial video (MV-HEVC)",
  sbs: "Side by side 3D",
  tb: "Top and bottom 3D",
};

const words = (map: Record<string, string>, v: string) => map[v.toLowerCase()] ?? v.toUpperCase();

/** "stereo", "5.1", "3 channels". */
function channelsWord(n: number): string {
  return n === 1 ? "mono" : n === 2 ? "stereo" : n === 6 ? "5.1" : n === 8 ? "7.1" : `${n} channels`;
}

/** 41_200_000 → "41 Mbit/s"; 256_000 → "256 kbit/s". */
function rate(bps: number): string {
  return bps >= 1_000_000 ? `${Math.round(bps / 1e6)} Mbit/s` : `${Math.round(bps / 1000)} kbit/s`;
}

export interface SourceRow {
  label: string;
  value: ReactNode;
}

/** The rows the project has data for, in reading order. With the
 * gateway's source_details (00175) the file, codec, colour, rotation,
 * audio, 3D and camera join the probe's; on projects analyzed before
 * (details_read false) those are unknown and left out. */
export function sourceRows(project: Project): SourceRow[] {
  const rows: SourceRow[] = [];
  const add = (label: string, value: ReactNode | null | undefined | false) => {
    if (value !== null && value !== undefined && value !== false && value !== "") rows.push({ label, value });
  };
  const p = project.probe;
  const d = project.source_details;
  const read = d?.details_read === true;
  const f = d?.file ?? null;
  const v = d?.video ?? null;

  // the file
  add("File", f?.name);
  const bytes = f?.bytes ?? project.source_bytes;
  add("Size", bytes && bytes > 0 ? formatBytes(bytes) : null);
  add("Container", f?.container ? f.container.toUpperCase() : null);
  const duration = f?.duration_s ?? p?.duration_s;
  add("Length", duration && duration > 0 ? formatVideoLength(duration) : null);

  // the picture
  const width = v?.width ?? p?.width;
  const height = v?.height ?? p?.height;
  add("Resolution", width && height ? `${width}×${height} · ${resolutionName({ width, height })}` : null);
  const fps = v?.fps ?? p?.fps;
  if (fps) {
    const vfr = v?.vfr ?? p?.vfr ?? false;
    const countedFrames = v?.counted_frames ?? p?.counted_frames;
    const counted = countedFrames && duration ? countedFrames / duration : null;
    add(
      "Frame rate",
      vfr && counted !== null
        ? `${fpsLabel(fps)} · variable, up to ${fpsLabel(counted)}`
        : vfr
          ? `${fpsLabel(fps)} · variable`
          : fpsLabel(fps),
    );
  }
  const frames = v?.frames ?? p?.num_frames;
  add("Frames", frames && frames > 0 ? frames.toLocaleString("en-US") : null);
  add("Codec", v?.codec ? [words(CODEC, v.codec), v.profile].filter(Boolean).join(" · ") : null);
  add("Bit depth", v?.bit_depth ? `${v.bit_depth}-bit` : null);
  const bitrate = v?.bitrate_bps ?? p?.bit_rate;
  add("Video bitrate", bitrate && bitrate > 0 ? rate(bitrate) : null);
  // colour: the transfer and primaries while HDR output is on, else the
  // dynamic range alone (also only then)
  const transfer = v?.color_transfer ? words(TRANSFER, v.color_transfer) : project.dynamic_range ? words(RANGE, project.dynamic_range) : null;
  const primaries = v?.color_primaries ? words(PRIMARIES, v.color_primaries) : null;
  add("Colour", [transfer, primaries].filter(Boolean).join(" · "));
  if (read && typeof v?.rotation === "number") add("Rotation", v.rotation === 0 ? "None" : `${v.rotation}°`);

  // the frame
  const crop = d?.source_crop ?? project.crop;
  if (project.has_bars === true && barSides({ ...project, crop: crop ?? undefined }) !== null) {
    const c = parseCrop(crop ?? undefined);
    add(
      "Black bars",
      ["Detected", c ? `picture ${c.width}×${c.height}` : null, removesBars(project) ? "removed in your 3D" : "kept in your 3D"]
        .filter(Boolean)
        .join(" · "),
    );
  } else if (project.has_bars === false) {
    add("Black bars", "None");
  }

  // sound, 3D and camera: known only once the file was read
  if (read) {
    const a = d.audio ?? null;
    add(
      "Audio",
      a
        ? [
            a.codec ? words(CODEC, a.codec) : null,
            a.channels ? channelsWord(a.channels) : null,
            a.sample_rate ? `${Math.round(a.sample_rate / 100) / 10} kHz` : null,
            a.bitrate_bps ? rate(a.bitrate_bps) : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "None",
    );
    const st = d.stereo ?? null;
    if (st) add("Spatial or 3D", st.layout ? (STEREO[st.layout] ?? st.layout) : st.spatial ? "Spatial video" : "No, 2D");
    const cam = d.camera ?? null;
    add("Camera", cam ? [cam.make, cam.model].filter(Boolean).join(" ") : null);
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
