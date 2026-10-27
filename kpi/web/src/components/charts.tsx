// Shared chart chrome for recharts: theme tokens, tooltip, last-point emphasis.
import type { ReactElement, ReactNode } from 'react'
import type { Unit } from '@/api/types'
import { fmtUnit } from '@/lib/format'

export const C = {
  s1: 'rgb(var(--s1))',
  s2: 'rgb(var(--s2))',
  s3: 'rgb(var(--s3))',
  s4: 'rgb(var(--s4))',
  s5: 'rgb(var(--s5))',
  ink3: 'rgb(var(--ink-3))',
  muted: 'rgb(var(--line-strong))',
  grid: 'rgb(var(--grid))',
  axis: 'rgb(var(--axis))',
  surface: 'rgb(var(--surface))',
  crit: 'rgb(var(--crit))',
  good: 'rgb(var(--good))',
}

export const AXIS = {
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 11 },
  tickMargin: 6,
} as const

export interface SeriesDef {
  key: string
  label: string
  color: string
  unit?: Unit
  dashed?: boolean
}

export interface TooltipItem {
  dataKey?: string | number
  name?: string | number
  value?: number | string | Array<number | string> | null
  color?: string
  payload?: Record<string, unknown>
}

export function ChartTooltip({
  active,
  payload,
  label,
  title,
  series,
}: {
  active?: boolean
  payload?: TooltipItem[]
  label?: string | number
  title?: (label: string) => string
  series: SeriesDef[]
}) {
  if (!active || !payload || payload.length === 0) return null
  const row = payload[0]?.payload ?? {}
  const heading = title ? title(String(label)) : String(label)
  return (
    <div className="rounded-md border border-line bg-surface px-2.5 py-2 text-xs shadow-pop">
      <div className="mb-1.5 font-medium text-ink">{heading}</div>
      <dl className="space-y-1">
        {series.map((s) => {
          const raw = row[s.key]
          const v = typeof raw === 'number' ? raw : null
          return (
            <div key={s.key} className="flex items-center justify-between gap-4">
              <dt className="flex items-center gap-1.5 text-ink-2">
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: s.color, outline: s.dashed ? `1px dashed ${s.color}` : undefined, outlineOffset: 1 }}
                />
                {s.label}
              </dt>
              <dd className="num font-medium text-ink">{fmtUnit(v, s.unit ?? 'count')}</dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

export function Legend({ series }: { series: SeriesDef[] }) {
  if (series.length < 2) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-3 rounded-sm"
            style={{
              background: s.dashed ? 'transparent' : s.color,
              border: s.dashed ? `1.5px dashed ${s.color}` : undefined,
              height: s.dashed ? 0 : undefined,
              marginTop: s.dashed ? 1 : undefined,
            }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  )
}

/** Index of the last point where `key` is a number, or -1. */
export function lastIndex<T extends object>(points: T[], key: keyof T): number {
  for (let i = points.length - 1; i >= 0; i--) {
    if (typeof points[i][key] === 'number') return i
  }
  return -1
}

/** Renders a dot only on the last valid point of a line; used as `dot` prop. */
export function lastDot(lastIdx: number, color: string) {
  return function LastDot(props: { cx?: number; cy?: number; index?: number; value?: number | null }): ReactElement<SVGElement> {
    if (props.index !== lastIdx || props.cx === undefined || props.cy === undefined || props.value === null) {
      return <g key={`nodot-${props.index ?? 'x'}`} />
    }
    return (
      <g key={`last-${props.index}`}>
        <circle cx={props.cx} cy={props.cy} r={5} fill={C.surface} />
        <circle cx={props.cx} cy={props.cy} r={3.5} fill={color} />
      </g>
    )
  }
}

export function ChartFrame({ title, hint, info, children }: { title: string; hint?: string; info?: ReactNode; children: ReactNode }) {
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1 text-sm font-semibold text-ink">
          {title}
          {info}
        </span>
        {hint ? <span className="truncate text-xs text-ink-3">{hint}</span> : null}
      </figcaption>
      {children}
    </figure>
  )
}

/** Horizontal bar list: label · bar · value. Single hue; identity by label. */
export function BarList({
  items,
  max,
  format,
  color = C.s1,
  emptyText = 'No data',
}: {
  items: { key: string; value: number; label?: string }[]
  max?: number
  format?: (v: number) => string
  color?: string
  emptyText?: string
}) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value))
  if (items.length === 0) return <p className="text-xs text-ink-3">{emptyText}</p>
  return (
    <ol className="space-y-1.5">
      {items.map((it) => (
        <li key={it.key} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2 text-xs">
          <span className="truncate text-ink-2" title={it.label ?? it.key}>
            {it.label ?? it.key}
          </span>
          <span className="h-2 overflow-hidden rounded-sm bg-surface-2">
            <span
              className="block h-full rounded-sm"
              style={{ width: `${Math.max(2, (it.value / top) * 100)}%`, background: color }}
            />
          </span>
          <span className="num min-w-[3.5rem] text-right font-medium text-ink">{format ? format(it.value) : it.value.toLocaleString()}</span>
        </li>
      ))}
    </ol>
  )
}
