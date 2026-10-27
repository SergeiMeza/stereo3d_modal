import { atom } from 'jotai'
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  differenceInCalendarMonths,
  endOfMonth,
  formatISO,
  isSameDay,
  parseISO,
  startOfMonth,
  subDays,
  subMonths,
} from 'date-fns'
import type { Grain } from '@/api/types'

// ---- persistence (localStorage, guarded) -----------------------------------

const KEY_PRESET = 's3dkpi.range.preset'
const KEY_CUSTOM = 's3dkpi.range.custom'
const KEY_THEME = 's3dkpi.theme'
const KEY_SIDEBAR = 's3dkpi.sidebarCollapsed'

function load<T>(key: string, fallback: T, validate: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    return validate(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable: ignore */
  }
}

// ---- date range --------------------------------------------------------------
// Every day is a UTC day, like the API's. The records are live, so the presets run through today.

export type RangePreset = 'last7' | 'last28' | 'last90' | 'last365' | 'thisMonth' | 'lastMonth' | 'all' | 'custom'

export const RANGE_PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last28', label: 'Last 28 days' },
  { id: 'last90', label: 'Last 90 days' },
  { id: 'last365', label: 'Last 365 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'all', label: 'Since launch' },
  { id: 'custom', label: 'Custom' },
]

/** The first prod record (conversions_prod) is from 2026-07-05; "Since launch" starts the month before. */
export const FIRST_DAY = '2026-07-01'

export interface DateRange {
  from: string // YYYY-MM-DD
  to: string // YYYY-MM-DD
}

const isPreset = (v: unknown): v is RangePreset => typeof v === 'string' && RANGE_PRESETS.some((p) => p.id === v)
const isRange = (v: unknown): v is DateRange =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as DateRange).from === 'string' &&
  typeof (v as DateRange).to === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test((v as DateRange).from) &&
  /^\d{4}-\d{2}-\d{2}$/.test((v as DateRange).to)

const iso = (d: Date) => formatISO(d, { representation: 'date' })

/** Today as a UTC calendar day, as a local Date at midnight (date-fns works in local time). */
export function utcToday(now = new Date()): Date {
  return new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

export function rangeForPreset(preset: RangePreset, today = utcToday()): DateRange | null {
  switch (preset) {
    case 'last7':
      return { from: iso(subDays(today, 6)), to: iso(today) }
    case 'last28':
      return { from: iso(subDays(today, 27)), to: iso(today) }
    case 'last90':
      return { from: iso(subDays(today, 89)), to: iso(today) }
    case 'last365':
      return { from: iso(subDays(today, 364)), to: iso(today) }
    case 'thisMonth':
      return { from: iso(startOfMonth(today)), to: iso(today) }
    case 'lastMonth': {
      const lm = subMonths(today, 1)
      return { from: iso(startOfMonth(lm)), to: iso(endOfMonth(lm)) }
    }
    case 'all':
      return { from: FIRST_DAY, to: iso(today) }
    case 'custom':
      return null
  }
}

const presetBase = atom<RangePreset>(load(KEY_PRESET, 'last28', isPreset))
export const presetAtom = atom(
  (get) => get(presetBase),
  (_get, set, next: RangePreset) => {
    set(presetBase, next)
    set(grainOverrideAtom, null)
    save(KEY_PRESET, next)
  },
)

const customBase = atom<DateRange>(load(KEY_CUSTOM, rangeForPreset('last28')!, isRange))
export const customRangeAtom = atom(
  (get) => get(customBase),
  (_get, set, next: DateRange) => {
    set(customBase, next)
    set(grainOverrideAtom, null)
    save(KEY_CUSTOM, next)
  },
)

/** The effective range. */
export const rangeAtom = atom((get) => rangeForPreset(get(presetAtom)) ?? get(customRangeAtom))

export function rangeDays(r: DateRange): number {
  try {
    return differenceInCalendarDays(parseISO(r.to), parseISO(r.from)) + 1
  } catch {
    return 0
  }
}

function wholeMonths(from: Date, to: Date): number | null {
  if (!isSameDay(from, startOfMonth(from)) || !isSameDay(to, endOfMonth(to))) return null
  return differenceInCalendarMonths(to, from) + 1
}

/** The same period one step earlier (-1) or later (+1); whole calendar months move by months. */
export function shiftRange(r: DateRange, step: -1 | 1): DateRange {
  const from = parseISO(r.from)
  const to = parseISO(r.to)
  const months = wholeMonths(from, to)
  if (months !== null) {
    const nextFrom = addMonths(from, months * step)
    return { from: iso(nextFrom), to: iso(endOfMonth(addMonths(nextFrom, months - 1))) }
  }
  const days = rangeDays(r)
  return { from: iso(addDays(from, days * step)), to: iso(addDays(to, days * step)) }
}

export function canShiftForward(r: DateRange, today = utcToday()): boolean {
  return r.to < iso(today)
}

export const stepRangeAtom = atom(null, (get, set, direction: -1 | 1) => {
  const next = shiftRange(get(rangeAtom), direction)
  set(customBase, next)
  save(KEY_CUSTOM, next)
  set(presetBase, 'custom')
  save(KEY_PRESET, 'custom')
})

// ---- grain -------------------------------------------------------------------

export function suggestedGrain(r: DateRange): Grain {
  const days = rangeDays(r)
  if (days > 400) return 'month'
  if (days > 92) return 'week'
  return 'day'
}

const grainOverrideAtom = atom<Grain | null>(null)

/** 'day' by default; suggests week/month for long ranges until the user picks one. */
export const grainAtom = atom(
  (get) => get(grainOverrideAtom) ?? suggestedGrain(get(rangeAtom)),
  (_get, set, next: Grain) => set(grainOverrideAtom, next),
)

// ---- refresh -------------------------------------------------------------------

/** Bumped by the header's Refresh button; every data hook keys on it. */
export const refreshTickAtom = atom(0)

// ---- theme ---------------------------------------------------------------------

export type ThemeSetting = 'system' | 'light' | 'dark'
const isTheme = (v: unknown): v is ThemeSetting => v === 'system' || v === 'light' || v === 'dark'
const themeBase = atom<ThemeSetting>(load(KEY_THEME, 'system', isTheme))
export const themeAtom = atom(
  (get) => get(themeBase),
  (_get, set, next: ThemeSetting) => {
    set(themeBase, next)
    save(KEY_THEME, next)
  },
)

export function resolveTheme(setting: ThemeSetting): 'light' | 'dark' {
  if (setting !== 'system') return setting
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

// ---- sidebar -------------------------------------------------------------------

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const sidebarBase = atom<boolean>(load(KEY_SIDEBAR, false, isBool))
export const sidebarCollapsedAtom = atom(
  (get) => get(sidebarBase),
  (_get, set, next: boolean) => {
    set(sidebarBase, next)
    save(KEY_SIDEBAR, next)
  },
)
