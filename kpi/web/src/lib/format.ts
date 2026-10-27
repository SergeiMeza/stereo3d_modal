import { format as fmtDate, parseISO } from 'date-fns'
import type { Grain, Unit } from '@/api/types'

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const dec1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export const EM_DASH = '—'

export function fmtUsd(v: number | null | undefined, opts: { cents?: boolean } = {}): string {
  if (v === null || v === undefined || Number.isNaN(v)) return EM_DASH
  return (opts.cents ? usd2 : usd0).format(v)
}

export function fmtCount(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return EM_DASH
  return int.format(v)
}

/** ratio 0..1 -> "12.3%" */
export function fmtRatio(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return EM_DASH
  const pct = v * 100
  return `${pct.toFixed(pct >= 100 || pct === 0 ? 0 : digits)}%`
}

export function fmtUnit(v: number | null | undefined, unit: Unit): string {
  switch (unit) {
    case 'usd':
      return fmtUsd(v)
    case 'count':
      return fmtCount(v)
    case 'ratio':
      return fmtRatio(v)
  }
}

export function fmtDec(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return EM_DASH
  return dec1.format(v)
}

/** Hours as a human duration: 12 min · 3.5 h · 2.1 d */
export function fmtHours(h: number | null | undefined): string {
  if (h === null || h === undefined || Number.isNaN(h)) return EM_DASH
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`
  if (h < 48) return `${dec1.format(h)} h`
  return `${dec1.format(h / 24)} d`
}

/** Seconds as a human duration: 45 s · 12 min · 1.5 h */
export function fmtSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || Number.isNaN(s)) return EM_DASH
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) return `${dec1.format(s / 60)} min`
  return `${dec1.format(s / 3600)} h`
}

/** Realtime multiple: 1.4× realtime (above 1 is faster than the source plays). */
export function fmtSpeed(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return EM_DASH
  return `${dec1.format(x)}× realtime`
}

/** Compact axis tick, e.g. 1.2K / $1.2K */
export function fmtAxis(v: number, unit: Unit = 'count'): string {
  if (unit === 'usd') return `$${compact.format(v)}`
  if (unit === 'ratio') return `${Math.round(v * 100)}%`
  return compact.format(v)
}

/** Percent change between current and previous; null when undefined. */
export function pctDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null
  if (previous === 0) return current === 0 ? 0 : null
  return (current - previous) / Math.abs(previous)
}

export function fmtDelta(d: number | null): string {
  if (d === null) return EM_DASH
  const pct = Math.abs(d * 100)
  const s = pct >= 100 ? pct.toFixed(0) : pct.toFixed(1)
  return `${d > 0 ? '+' : d < 0 ? '−' : ''}${s}%`
}

export function fmtDay(iso: string, grain: Grain = 'day'): string {
  try {
    const d = parseISO(iso)
    if (grain === 'month') return fmtDate(d, 'MMM yyyy')
    if (grain === 'week') return `wk ${fmtDate(d, 'd MMM')}`
    return fmtDate(d, 'd MMM')
  } catch {
    return iso
  }
}

export function fmtDayLong(iso: string, grain: Grain = 'day'): string {
  try {
    const d = parseISO(iso)
    if (grain === 'month') return fmtDate(d, 'MMMM yyyy')
    if (grain === 'week') return `Week of ${fmtDate(d, 'd MMM yyyy')}`
    return fmtDate(d, 'EEE d MMM yyyy')
  } catch {
    return iso
  }
}

/** A timestamp as UTC (the dashboard's time zone everywhere), e.g. "27 Oct, 17:12". */
export function fmtDateTime(iso: string | null): string {
  if (!iso) return 'never'
  try {
    const d = parseISO(iso)
    return fmtDate(new Date(d.getTime() + d.getTimezoneOffset() * 60_000), 'd MMM, HH:mm')
  } catch {
    return iso
  }
}

export function fmtRange(from: string, to: string): string {
  try {
    const a = parseISO(from)
    const b = parseISO(to)
    const sameYear = a.getFullYear() === b.getFullYear()
    return `${fmtDate(a, sameYear ? 'd MMM' : 'd MMM yyyy')} – ${fmtDate(b, 'd MMM yyyy')}`
  } catch {
    return `${from} – ${to}`
  }
}

/** Absolute timestamp to the second, for a title attribute. */
export function fmtExact(iso: string | null | undefined): string {
  if (!iso) return EM_DASH
  try {
    return fmtDate(parseISO(iso), 'EEE d MMM yyyy, HH:mm:ss')
  } catch {
    return iso
  }
}

/** "just now" · "3 min ago" · "2 h ago" · "6 d ago"; future times read "in …". */
export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return EM_DASH
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const secs = Math.round((now - t) / 1000)
  const ago = secs >= 0
  const a = Math.abs(secs)
  const body =
    a < 10 ? 'just now' : a < 60 ? `${a} s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 86_400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86_400)} d`
  if (body === 'just now') return body
  return ago ? `${body} ago` : `in ${body}`
}

/** A session length: 0:42 · 12:05 · 1:22:40 (never an em dash for 0). */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return EM_DASH
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/** A uid or install id shortened for a table cell, with the full value kept for the title. */
export function shortId(id: string | null | undefined, head = 6, tail = 4): string {
  if (!id) return EM_DASH
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`
}
