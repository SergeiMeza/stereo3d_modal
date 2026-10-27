import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { KpiCard as KpiCardT } from '@/api/types'
import { Card } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtDelta, fmtUnit, pctDelta } from '@/lib/format'
import { cn } from '@/lib/utils'

/** One KPI with its change against the previous period of the same length (the Spatial Video Studio
 *  KPI's card). `inverted` metrics are better when they go down. */
export function KpiCard({ card, inverted = false }: { card: KpiCardT; inverted?: boolean }) {
  const delta = pctDelta(card.value, card.previous)
  const dir = delta === null ? null : delta > 0.0005 ? 'up' : delta < -0.0005 ? 'down' : 'flat'
  const tone = dir === null || dir === 'flat' ? 'text-ink-3' : (dir === 'up') !== inverted ? 'text-good' : 'text-crit'
  const Arrow = dir === 'up' ? ArrowUpRight : dir === 'down' ? ArrowDownRight : Minus
  return (
    <Card className="flex min-h-[7.25rem] flex-col justify-between p-4">
      <p className="text-xs font-medium text-ink-2">{card.label}</p>
      <div>
        <p className="num font-display text-[1.75rem] font-semibold leading-none tracking-tight text-ink">{fmtUnit(card.value, card.unit)}</p>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn('num inline-flex items-center gap-0.5 font-medium', tone)}>
                <Arrow className="h-3.5 w-3.5" aria-hidden />
                {fmtDelta(delta)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Previous period: <span className="num font-medium">{fmtUnit(card.previous, card.unit)}</span>
            </TooltipContent>
          </Tooltip>
          {card.note ? <span className="truncate text-ink-3">{card.note}</span> : null}
        </div>
      </div>
    </Card>
  )
}

export function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>
}
