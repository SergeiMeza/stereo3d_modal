import type { ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function Section({
  id,
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  id: string
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn('scroll-mt-20', className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight text-ink">
            {title}
          </h2>
          {subtitle ? <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function ErrorCard({ message, onRetry, className }: { message: string; onRetry: () => void; className?: string }) {
  return (
    <Card role="alert" className={cn('border-crit/40', className)}>
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-crit/10 text-crit">
          <AlertTriangle className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Couldn’t load this section</p>
          <p className="truncate font-mono text-xs text-ink-2" title={message}>
            {message}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
          Retry
        </Button>
      </CardContent>
    </Card>
  )
}

/** Faint "loading" veil laid over stale content while the next range loads. */
export function Reloading({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div aria-busy={active || undefined} className={cn('transition-opacity', active && 'opacity-60')}>
      {children}
    </div>
  )
}

/** A small number card: label, value, the comparison line and a hint. */
export function Stat({ label, value, previous, hint, tone }: { label: string; value: string; previous?: string; hint?: string; tone?: 'good' | 'bad' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-ink-3">{label}</p>
        <p className={cn('num mt-1 text-xl font-semibold text-ink', tone === 'good' && 'text-good', tone === 'bad' && 'text-warn')}>{value}</p>
        {previous ? <p className="text-xs text-ink-3">{previous}</p> : null}
        {hint ? <p className="mt-1 text-[0.7rem] text-ink-3">{hint}</p> : null}
      </CardContent>
    </Card>
  )
}

/** A table's title row inside a padding-less card. */
export function TableTitle({ title, info, hint }: { title: string; info?: ReactNode; hint?: string }) {
  return (
    <p className="flex items-center gap-1 px-4 pt-4 text-sm font-semibold text-ink">
      {title}
      {info}
      {hint ? <span className="ml-auto text-xs font-normal text-ink-3">{hint}</span> : null}
    </p>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="p-4 text-sm text-ink-3">{children}</p>
}
