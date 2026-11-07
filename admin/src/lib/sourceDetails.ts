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

export interface SourceInfo {
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

/** The rows the source has data for, in reading order. */
export function sourceRows(src: SourceInfo): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) rows.push({ label, value });
  };
  const p = src.probe ?? null;
  add("Size", src.source_bytes && src.source_bytes > 0 ? formatBytes(src.source_bytes) : null);
  add("Length", p?.duration_s && p.duration_s > 0 ? formatVideoLength(p.duration_s) : null);
  if (p) {
    add("Resolution", `${p.width}×${p.height} · ${resolutionName(p)}`);
    const counted = p.counted_frames && p.duration_s ? p.counted_frames / p.duration_s : null;
    add(
      "Frame rate",
      p.vfr && counted !== null ? `${fpsLabel(p.fps)} · variable, up to ${fpsLabel(counted)}` : p.vfr ? `${fpsLabel(p.fps)} · variable` : fpsLabel(p.fps),
    );
    add("Frames", p.num_frames && p.num_frames > 0 ? p.num_frames.toLocaleString("en-US") : null);
    add("Video bitrate", p.bit_rate && p.bit_rate > 0 ? `${Math.round(p.bit_rate / 1e6)} Mbit/s` : null);
  }
  add("Dynamic range", src.dynamic_range ? (RANGE[src.dynamic_range] ?? src.dynamic_range.toUpperCase()) : null);
  if (src.has_bars === true) {
    const m = /^(\d+):(\d+):\d+:\d+$/.exec(src.crop ?? "");
    add(
      "Black bars",
      ["Detected", m ? `picture ${m[1]}×${m[2]}` : null, src.remove_bars === false ? "kept in 3D" : "removed in 3D"].filter(Boolean).join(" · "),
    );
  } else if (src.has_bars === false) {
    add("Black bars", "None");
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
