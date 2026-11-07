/**
 * A run's source video in rows (owner 2026-11-07), as the web's Overview
 * "Source details" shows them, with the same formatters: size, length,
 * resolution, frame rate (variable frame rate noted), frames, the video's
 * bitrate, the dynamic range and the black bars. Only what the gateway
 * reports, never an estimate. The admin run payloads carry the run's
 * project probe as `source` (or `probe` with the project's fields beside
 * it) once the gateway adds them.
 */

export interface SourceProbe {
  width: number;
  height: number;
  fps: number;
  duration_s?: number;
  num_frames?: number;
  bit_rate?: number;
  counted_frames?: number;
  vfr?: boolean;
}

/** gateway 00175: the source file's facts (the console always gets the
 * colour). details_read false: codec, audio, 3D and camera unknown. */
export interface SourceFileDetails {
  details_read: boolean;
  file?: { name?: string | null; bytes?: number | null; container?: string | null; duration_s?: number | null } | null;
  video?: {
    width?: number | null;
    height?: number | null;
    fps?: number | null;
    vfr?: boolean | null;
    frames?: number | null;
    counted_frames?: number | null;
    codec?: string | null;
    profile?: string | null;
    bit_depth?: number | null;
    bitrate_bps?: number | null;
    color_transfer?: string | null;
    color_primaries?: string | null;
    rotation?: number | null;
  } | null;
  source_crop?: string | null;
  audio?: { codec?: string | null; channels?: number | null; sample_rate?: number | null; bitrate_bps?: number | null } | null;
  stereo?: { spatial?: boolean | null; layout?: string | null } | null;
  camera?: { make?: string | null; model?: string | null } | null;
}

export interface SourceInfo {
  source_details?: SourceFileDetails | null;
  probe?: SourceProbe | null;
  source_bytes?: number;
  has_bars?: boolean;
  crop?: string;
  remove_bars?: boolean;
  dynamic_range?: string;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = -1;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

export function formatVideoLength(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return m === 0 ? `${h} h` : `${h} h ${m} min`;
  return rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}

function fpsLabel(v: number): string {
  const r = Math.round(v * 100) / 100;
  return `${Number.isInteger(r) ? r : r.toFixed(2)} fps`;
}

function resolutionName(p: { width: number; height: number }): string {
  const short = Math.min(p.width, p.height);
  if (short >= 4320) return "8K";
  if (short >= 3240) return "6K";
  if (short >= 2880) return "5K";
  if (short >= 2160) return "4K";
  if (short >= 1620) return "3K";
  if (short >= 1440) return "1440p";
  return `${short}p`;
}

const RANGE: Record<string, string> = { sdr: "SDR", hlg: "HDR (HLG)", pq: "HDR (PQ)", dv_8: "Dolby Vision", dv_5: "Dolby Vision" };

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
  bt470bg: "SDR",
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

const STEREO: Record<string, string> = { mvhevc: "Spatial video (MV-HEVC)", sbs: "Side by side 3D", tb: "Top and bottom 3D" };

const named = (map: Record<string, string>, v: string) => map[v.toLowerCase()] ?? v.toUpperCase();

function channelsWord(n: number): string {
  return n === 1 ? "mono" : n === 2 ? "stereo" : n === 6 ? "5.1" : n === 8 ? "7.1" : `${n} channels`;
}

function rate(bps: number): string {
  return bps >= 1_000_000 ? `${Math.round(bps / 1e6)} Mbit/s` : `${Math.round(bps / 1000)} kbit/s`;
}

/** The rows the source has data for, in reading order: the web's Source
 * details, from source_details where the gateway read the file, else the
 * probe. */
export function sourceRows(src: SourceInfo): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) rows.push({ label, value });
  };
  const p = src.probe ?? null;
  const d = src.source_details ?? null;
  const read = d?.details_read === true;
  const f = d?.file ?? null;
  const v = d?.video ?? null;

  add("File", f?.name);
  const bytes = f?.bytes ?? src.source_bytes;
  add("Size", bytes && bytes > 0 ? formatBytes(bytes) : null);
  add("Container", f?.container ? f.container.toUpperCase() : null);
  const duration = f?.duration_s ?? p?.duration_s;
  add("Length", duration && duration > 0 ? formatVideoLength(duration) : null);

  const width = v?.width ?? p?.width;
  const height = v?.height ?? p?.height;
  add("Resolution", width && height ? `${width}×${height} · ${resolutionName({ width, height })}` : null);
  const fps = v?.fps ?? p?.fps;
  if (fps) {
    const vfr = v?.vfr ?? p?.vfr ?? false;
    const countedFrames = v?.counted_frames ?? p?.counted_frames;
    const counted = countedFrames && duration ? countedFrames / duration : null;
    add("Frame rate", vfr && counted !== null ? `${fpsLabel(fps)} · variable, up to ${fpsLabel(counted)}` : vfr ? `${fpsLabel(fps)} · variable` : fpsLabel(fps));
  }
  const frames = v?.frames ?? p?.num_frames;
  add("Frames", frames && frames > 0 ? frames.toLocaleString("en-US") : null);
  add("Codec", v?.codec ? [named(CODEC, v.codec), v.profile].filter(Boolean).join(" · ") : null);
  add("Bit depth", v?.bit_depth ? `${v.bit_depth}-bit` : null);
  const bitrate = v?.bitrate_bps ?? p?.bit_rate;
  add("Video bitrate", bitrate && bitrate > 0 ? rate(bitrate) : null);
  const transfer = v?.color_transfer ? named(TRANSFER, v.color_transfer) : src.dynamic_range ? named(RANGE, src.dynamic_range) : null;
  const primaries = v?.color_primaries ? named(PRIMARIES, v.color_primaries) : null;
  add("Colour", [transfer, primaries].filter(Boolean).join(" · "));
  if (read && typeof v?.rotation === "number") add("Rotation", v.rotation === 0 ? "None" : `${v.rotation}°`);

  const crop = d?.source_crop ?? src.crop;
  if (src.has_bars === true) {
    const m = /^(\d+):(\d+):\d+:\d+$/.exec(crop ?? "");
    add("Black bars", ["Detected", m ? `picture ${m[1]}×${m[2]}` : null, src.remove_bars === false ? "kept in 3D" : "removed in 3D"].filter(Boolean).join(" · "));
  } else if (src.has_bars === false) {
    add("Black bars", "None");
  }

  if (read && d) {
    const a = d.audio ?? null;
    add(
      "Audio",
      a
        ? [
            a.codec ? named(CODEC, a.codec) : null,
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

/** The source as an admin run payload carries it. */
export function sourceOf(run: { source?: SourceInfo | null; probe?: SourceProbe | null } & Partial<SourceInfo>): SourceInfo | null {
  if (run.source) return run.source;
  if (!run.probe) return null;
  return {
    probe: run.probe,
    source_bytes: run.source_bytes,
    has_bars: run.has_bars,
    crop: run.crop,
    remove_bars: run.remove_bars,
    dynamic_range: run.dynamic_range,
  };
}
