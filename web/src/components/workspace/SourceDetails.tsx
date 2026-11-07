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
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
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

/** 3D layouts → their message keys. */
const STEREO: Record<string, string> = {
  mvhevc: "mvhevc",
  sbs: "sbs",
  tb: "tb",
};

const words = (map: Record<string, string>, v: string) => map[v.toLowerCase()] ?? v.toUpperCase();

/** "stereo", "5.1", "3 channels". */
function channelsWord(n: number, t: Tr): string {
  return n === 1
    ? t("workspace.source.channels.mono")
    : n === 2
      ? t("workspace.source.channels.stereo")
      : n === 6
        ? "5.1"
        : n === 8
          ? "7.1"
          : t("workspace.source.channels.many", { count: String(n) });
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
export function sourceRows(project: Project, t: Tr = EN): SourceRow[] {
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
  add(t("workspace.source.rows.file"), f?.name);
  const bytes = f?.bytes ?? project.source_bytes;
  add(t("workspace.source.rows.size"), bytes && bytes > 0 ? formatBytes(bytes) : null);
  add(t("workspace.source.rows.container"), f?.container ? f.container.toUpperCase() : null);
  const duration = f?.duration_s ?? p?.duration_s;
  add(t("workspace.source.rows.length"), duration && duration > 0 ? formatVideoLength(duration) : null);

  // the picture
  const width = v?.width ?? p?.width;
  const height = v?.height ?? p?.height;
  add(t("workspace.source.rows.resolution"), width && height ? `${width}×${height} · ${resolutionName({ width, height })}` : null);
  const fps = v?.fps ?? p?.fps;
  if (fps) {
    const vfr = v?.vfr ?? p?.vfr ?? false;
    const countedFrames = v?.counted_frames ?? p?.counted_frames;
    const counted = countedFrames && duration ? countedFrames / duration : null;
    add(
      t("workspace.source.rows.frameRate"),
      vfr && counted !== null
        ? t("workspace.source.variableUpTo", { fps: fpsLabel(fps), max: fpsLabel(counted) })
        : vfr
          ? t("workspace.source.variable", { fps: fpsLabel(fps) })
          : fpsLabel(fps),
    );
  }
  const frames = v?.frames ?? p?.num_frames;
  add(t("workspace.source.rows.frames"), frames && frames > 0 ? frames.toLocaleString(t.intl) : null);
  add(t("workspace.source.rows.codec"), v?.codec ? [words(CODEC, v.codec), v.profile].filter(Boolean).join(" · ") : null);
  add(t("workspace.source.rows.bitDepth"), v?.bit_depth ? t("workspace.source.bitDepth", { bits: String(v.bit_depth) }) : null);
  const bitrate = v?.bitrate_bps ?? p?.bit_rate;
  add(t("workspace.source.rows.videoBitrate"), bitrate && bitrate > 0 ? rate(bitrate) : null);
  // colour: the transfer and primaries while HDR output is on, else the
  // dynamic range alone (also only then)
  const transfer = v?.color_transfer ? words(TRANSFER, v.color_transfer) : project.dynamic_range ? words(RANGE, project.dynamic_range) : null;
  const primaries = v?.color_primaries ? words(PRIMARIES, v.color_primaries) : null;
  add(t("workspace.source.rows.colour"), [transfer, primaries].filter(Boolean).join(" · "));
  if (read && typeof v?.rotation === "number") {
    add(t("workspace.source.rows.rotation"), v.rotation === 0 ? t("workspace.source.none") : `${v.rotation}°`);
  }

  // the frame
  const crop = d?.source_crop ?? project.crop;
  if (project.has_bars === true && barSides({ ...project, crop: crop ?? undefined }) !== null) {
    const c = parseCrop(crop ?? undefined);
    add(
      t("workspace.source.rows.bars"),
      [
        t("workspace.source.bars.detected"),
        c ? t("workspace.source.bars.picture", { size: `${c.width}×${c.height}` }) : null,
        removesBars(project) ? t("workspace.source.bars.removed") : t("workspace.source.bars.kept"),
      ]
        .filter(Boolean)
        .join(" · "),
    );
  } else if (project.has_bars === false) {
    add(t("workspace.source.rows.bars"), t("workspace.source.none"));
  }

  // sound, 3D and camera: known only once the file was read
  if (read) {
    const a = d.audio ?? null;
    add(
      t("workspace.source.rows.audio"),
      a
        ? [
            a.codec ? words(CODEC, a.codec) : null,
            a.channels ? channelsWord(a.channels, t) : null,
            a.sample_rate ? `${Math.round(a.sample_rate / 100) / 10} kHz` : null,
            a.bitrate_bps ? rate(a.bitrate_bps) : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : t("workspace.source.none"),
    );
    const st = d.stereo ?? null;
    if (st) {
      const layout = st.layout ? STEREO[st.layout] : undefined;
      add(
        t("workspace.source.rows.stereo"),
        st.layout
          ? layout
            ? t(`workspace.source.stereo.${layout}`)
            : st.layout
          : st.spatial
            ? t("workspace.source.stereo.spatial")
            : t("workspace.source.stereo.flat"),
      );
    }
    const cam = d.camera ?? null;
    add(t("workspace.source.rows.camera"), cam ? [cam.make, cam.model].filter(Boolean).join(" ") : null);
  }
  return rows;
}

export function SourceDetails({ project }: { project: Project }): JSX.Element | null {
  const t = useT();
  const [open, setOpen] = useAppAtom(sourceDetailsOpenAtom);
  const rows = sourceRows(project, t);
  if (rows.length === 0) return null;
  return (
    <section aria-label={t("workspace.source.title")} className="min-w-0">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger
          data-testid="source-details-toggle"
          className="group inline-flex items-center gap-1 text-sm font-semibold text-fg hover:text-fg"
        >
          {t("workspace.source.title")}
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
