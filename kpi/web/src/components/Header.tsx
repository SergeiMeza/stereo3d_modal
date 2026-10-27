import { useEffect, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Check, ChevronLeft, ChevronRight, Database, Moon, RefreshCw, Sun, SunMoon } from 'lucide-react'
import { runIngest } from '@/api/client'
import type { Meta, SourceStatus } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMeta, type ApiState } from '@/hooks/useApi'
import { fmtDateTime, fmtRange } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  RANGE_PRESETS,
  canShiftForward,
  customRangeAtom,
  grainAtom,
  presetAtom,
  rangeAtom,
  rangeDays,
  refreshTickAtom,
  shiftRange,
  stepRangeAtom,
  suggestedGrain,
  themeAtom,
  type RangePreset,
  type ThemeSetting,
} from '@/state'

export function Header() {
  const meta = useMeta()
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ground/85 backdrop-blur supports-[backdrop-filter]:bg-ground/70">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6 lg:px-8">
        <h1 className="mr-auto flex items-baseline gap-2 text-sm font-semibold tracking-tight text-ink">
          <span aria-hidden className="inline-block h-2.5 w-2.5 translate-y-[-1px] rounded-[3px] bg-accent" />
          Stereo3D Studio
          <span className="font-normal text-ink-3">· KPIs</span>
        </h1>
        <RefreshButton />
        <SourcesPopover meta={meta} />
        <ThemeToggle />
      </div>
    </header>
  )
}

// ---- date range --------------------------------------------------------------

export function RangeControl() {
  const [preset, setPreset] = useAtom(presetAtom)
  const [custom, setCustom] = useAtom(customRangeAtom)
  const range = useAtomValue(rangeAtom)
  const step = useSetAtom(stepRangeAtom)
  const [draft, setDraft] = useState(custom)
  useEffect(() => setDraft(custom), [custom])

  const applyDraft = () => {
    if (!draft.from || !draft.to) return
    const [from, to] = draft.from <= draft.to ? [draft.from, draft.to] : [draft.to, draft.from]
    setCustom({ from, to })
  }
  const canGoForward = canShiftForward(range)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <RangeStepButton
        direction={-1}
        label="Previous period"
        preview={fmtRange(shiftRange(range, -1).from, shiftRange(range, -1).to)}
        onClick={() => step(-1)}
      />
      <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
        <SelectTrigger aria-label="Date range" className="w-[9.5rem]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RANGE_PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {preset === 'custom' ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            applyDraft()
          }}
        >
          <Input type="date" aria-label="From" value={draft.from} max={draft.to} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className="w-[9.25rem]" />
          <span className="text-ink-3">–</span>
          <Input type="date" aria-label="To" value={draft.to} min={draft.from} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className="w-[9.25rem]" />
          <Button type="submit" variant="subtle" size="sm" disabled={draft.from === custom.from && draft.to === custom.to}>
            Apply
          </Button>
        </form>
      ) : (
        <span className="num hidden text-xs text-ink-3 md:inline">
          {fmtRange(range.from, range.to)} · {rangeDays(range)}d · UTC
        </span>
      )}
      <RangeStepButton
        direction={1}
        label="Next period"
        preview={canGoForward ? fmtRange(shiftRange(range, 1).from, shiftRange(range, 1).to) : 'The range already reaches today'}
        disabled={!canGoForward}
        onClick={() => step(1)}
      />
    </div>
  )
}

function RangeStepButton({ direction, label, preview, disabled, onClick }: { direction: -1 | 1; label: string; preview: string; disabled?: boolean; onClick: () => void }) {
  const Icon = direction === -1 ? ChevronLeft : ChevronRight
  const button = (
    <Button variant="outline" size="icon" aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon className="h-4 w-4" aria-hidden />
    </Button>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>{disabled ? <span className="inline-flex">{button}</span> : button}</TooltipTrigger>
      <TooltipContent>
        {label}
        <span className="num ml-1 text-ink-3">{preview}</span>
      </TooltipContent>
    </Tooltip>
  )
}

export function GrainControl() {
  const [grain, setGrain] = useAtom(grainAtom)
  const range = useAtomValue(rangeAtom)
  const suggested = suggestedGrain(range)
  return (
    <Select value={grain} onValueChange={(v) => setGrain(v as typeof grain)}>
      <SelectTrigger aria-label="Time grain" className="w-[6.5rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(['day', 'week', 'month'] as const).map((g) => (
          <SelectItem key={g} value={g}>
            {g === 'day' ? 'Daily' : g === 'week' ? 'Weekly' : 'Monthly'}
            {g === suggested && g !== 'day' ? <span className="ml-1 text-ink-3">· suggested</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---- refresh -------------------------------------------------------------------

function RefreshButton() {
  const bump = useSetAtom(refreshTickAtom)
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'done' | 'fail'; text: string }>({ kind: 'idle' })

  useEffect(() => {
    if (state.kind !== 'done' && state.kind !== 'fail') return
    const t = setTimeout(() => setState({ kind: 'idle' }), 6000)
    return () => clearTimeout(t)
  }, [state])

  const run = async () => {
    setState({ kind: 'busy' })
    try {
      const r = await runIngest()
      setState({ kind: 'done', text: r.detail || (r.started ? 'Ingest started' : 'Ingest not started') })
      // The loop takes the request within 30 s and a pass takes a few seconds: refetch twice.
      setTimeout(() => bump((n) => n + 1), 1500)
      setTimeout(() => bump((n) => n + 1), 45000)
    } catch (e) {
      setState({ kind: 'fail', text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="relative flex items-center">
      <Button variant="outline" onClick={run} disabled={state.kind === 'busy'} aria-live="polite">
        <RefreshCw className={cn('h-3.5 w-3.5', state.kind === 'busy' && 'animate-spin')} aria-hidden />
        Refresh data
      </Button>
      {state.kind === 'done' || state.kind === 'fail' ? (
        <div
          role="status"
          className={cn(
            'absolute right-0 top-full mt-2 w-72 rounded-md border px-3 py-2 text-xs shadow-pop animate-fade-in',
            state.kind === 'done' ? 'border-good/40 bg-surface text-ink' : 'border-crit/40 bg-surface text-ink',
          )}
        >
          <span className="flex items-start gap-2">
            <span className={cn('mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full', state.kind === 'done' ? 'bg-good' : 'bg-crit')} />
            <span className="min-w-0 break-words">
              <span className="font-medium">{state.kind === 'done' ? 'Refresh requested' : 'Refresh failed'}</span>
              <br />
              <span className="text-ink-2">{state.text}</span>
            </span>
          </span>
        </div>
      ) : null}
    </div>
  )
}

// ---- sources -------------------------------------------------------------------

const STATUS_DOT: Record<SourceStatus['status'], string> = {
  ok: 'bg-good',
  pending: 'bg-warn',
  skipped: 'bg-warn',
  error: 'bg-crit',
  never: 'bg-line-strong',
}

function SourcesPopover({ meta }: { meta: ApiState<Meta> }) {
  const sources = meta.data?.sources ?? []
  const worst = sources.some((s) => s.status === 'error')
    ? 'error'
    : sources.some((s) => s.status === 'pending' || s.status === 'skipped')
      ? 'pending'
      : sources.some((s) => s.status === 'never')
        ? 'never'
        : 'ok'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label="Data sources">
          <Database className="h-3.5 w-3.5" aria-hidden />
          Sources
          <span aria-hidden className={cn('ml-0.5 inline-block h-2 w-2 rounded-full', meta.data ? STATUS_DOT[worst] : 'bg-line-strong')} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[24rem]">
        <div className="mb-2 flex items-baseline justify-between">
          <p className="text-sm font-semibold">Data sources</p>
          {meta.data ? <p className="num text-xs text-ink-3">generated {fmtDateTime(meta.data.generated_at)}</p> : null}
        </div>
        {meta.error ? (
          <p className="text-xs text-crit">{meta.error}</p>
        ) : !meta.data ? (
          <p className="text-xs text-ink-3">Loading…</p>
        ) : (
          <ul className="divide-y divide-line">
            {meta.data.sources.map((s) => (
              <li key={s.id} className="flex gap-2.5 py-2">
                <span aria-hidden className={cn('mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full', STATUS_DOT[s.status])} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-ink">{s.label}</span>
                    <span className="num shrink-0 text-[11px] text-ink-3">
                      {s.status} · {fmtDateTime(s.last_run)}
                    </span>
                  </div>
                  {s.detail ? <p className="mt-0.5 break-words text-xs text-ink-2">{s.detail}</p> : null}
                  {s.from && s.to ? (
                    <p className="num mt-0.5 text-[11px] text-ink-3">
                      {s.from} → {s.to}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {meta.data ? (
          <p className="mt-2 border-t border-line pt-2 text-[11px] text-ink-3">
            {meta.data.app.name} · Firestore {meta.data.app.firestore_env} · {meta.data.currency} · days in {meta.data.timezone}
            {meta.data.other_currency_records > 0 ? ` · ${meta.data.other_currency_records} records not in USD` : ''}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

// ---- theme ---------------------------------------------------------------------

const NEXT: Record<ThemeSetting, ThemeSetting> = { system: 'light', light: 'dark', dark: 'system' }

function ThemeToggle() {
  const [theme, setTheme] = useAtom(themeAtom)
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : SunMoon
  const label = theme === 'system' ? 'Theme: follows system' : theme === 'light' ? 'Theme: light' : 'Theme: dark'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} onClick={() => setTheme(NEXT[theme])}>
          <Icon className="h-4 w-4" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {theme === 'system' ? <Check className="ml-1 inline h-3 w-3" aria-hidden /> : null}
      </TooltipContent>
    </Tooltip>
  )
}
