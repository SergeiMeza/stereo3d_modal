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

/** "about 3 min left" / "about 40 s left" / "about 1 h 5 min left". */
export function formatTimeLeft(seconds: number): string {
  if (seconds < 55) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s left`;
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `about ${totalMin} min left`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `about ${h} h left` : `about ${h} h ${m} min left`;
}
