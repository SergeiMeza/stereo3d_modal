import { GrainControl, RangeControl } from '@/components/Header'

export type FilterKey = 'range' | 'grain'

/** The filter row at the top of a page: only the controls the page's numbers respond to. Each is a
 *  shared setting, so a choice made on one page holds on the next. */
export function PageFilters({ controls, note }: { controls: FilterKey[]; note?: string }) {
  if (controls.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface/60 px-3 py-2">
      {controls.includes('range') ? <RangeControl /> : null}
      {controls.includes('grain') ? <GrainControl /> : null}
      {note ? <p className="ml-auto text-xs text-ink-3">{note}</p> : null}
    </div>
  )
}
