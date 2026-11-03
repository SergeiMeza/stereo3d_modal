/**
 * The ONE time and size formatting for customer copy (S3D-34): every
 * estimate reads "about 12 min", every countdown "about 12 min left".
 */

/** "1.2 GB" / "850 MB" — binary units, one decimal under 100. */
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

/** "about 40 s" / "about 12 min" / "about 1 h 5 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 55) {
    return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  }
  const totalMin = Math.max(1, Math.round(seconds / 60));
  if (totalMin < 60) return `about ${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `about ${h} h` : `about ${h} h ${m} min`;
}

/** "about 12 min left". */
export function formatTimeLeft(seconds: number): string {
  return `${formatDuration(seconds)} left`;
}

/** A video length: "45 s" / "5 min 12 s" / "1 h 4 min". */
export function formatVideoLength(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return m === 0 ? `${h} h` : `${h} h ${m} min`;
  return rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}
