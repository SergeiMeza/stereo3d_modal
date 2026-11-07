import { EN, type Tr } from "@/lib/i18n/t";

/**
 * The ONE time and size formatting for customer copy (S3D-34): every
 * estimate reads "about 12 min", every countdown "about 12 min left".
 * Each takes the reader's translator last (English by default).
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
export function formatDuration(seconds: number, t: Tr = EN): string {
  if (seconds < 55) {
    return t("common.format.aboutSeconds", { s: String(Math.max(5, Math.round(seconds / 5) * 5)) });
  }
  const totalMin = Math.max(1, Math.round(seconds / 60));
  if (totalMin < 60) return t("common.format.aboutMinutes", { m: String(totalMin) });
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0
    ? t("common.format.aboutHours", { h: String(h) })
    : t("common.format.aboutHoursMinutes", { h: String(h), m: String(m) });
}

/** "about 12 min left". */
export function formatTimeLeft(seconds: number, t: Tr = EN): string {
  return t("common.format.left", { duration: formatDuration(seconds, t) });
}

/** A video length: "45 s" / "5 min 12 s" / "1 h 4 min". */
export function formatVideoLength(seconds: number, t: Tr = EN): string {
  const s = Math.round(seconds);
  if (s < 60) return t("common.format.seconds", { s: String(s) });
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return m === 0 ? t("common.format.hours", { h: String(h) }) : t("common.format.hoursMinutes", { h: String(h), m: String(m) });
  return rest === 0
    ? t("common.format.minutes", { m: String(m) })
    : t("common.format.minutesSeconds", { m: String(m), s: String(rest) });
}

/** m:ss / h:mm:ss for a thumbnail corner: "5:12". */
export function formatClock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** "Nov 7": a day in the same year, in the reader's language. */
export function formatShortDay(iso: string, t: Tr = EN): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(t.intl, { month: "short", day: "numeric" });
}
