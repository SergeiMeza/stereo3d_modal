import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import type { MarginRow } from '@/api/types'
import { AXIS, C, ChartFrame, ChartTooltip, Legend, type SeriesDef } from '@/components/charts'
import { HowToRead, InfoButton } from '@/components/InfoModal'
import { Empty, ErrorCard, Reloading, Section, Stat, TableTitle } from '@/components/Section'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useMargin } from '@/hooks/useApi'
import { EM_DASH, fmtAxis, fmtCount, fmtDateTime, fmtDay, fmtDayLong, fmtRange, fmtRatio, fmtUsd } from '@/lib/format'
import { runTypeLabel, shortId } from '@/lib/labels'
import { cn } from '@/lib/utils'

const H = 260
const SERIES: SeriesDef[] = [
  { key: 'revenue', label: 'Revenue', color: C.s1, unit: 'usd' },
  { key: 'cost', label: 'GPU cost', color: C.s2, unit: 'usd' },
  { key: 'margin', label: 'Gross margin', color: C.ink3, unit: 'usd', dashed: true },
]

/** Cents matter here: a photo costs a fraction of a cent, a depth preview a few dimes. */
const money = (v: number | null | undefined) => {
  if (v === null || v === undefined) return EM_DASH
  return Math.abs(v) > 0 && Math.abs(v) < 0.01 ? `$${v.toFixed(4)}` : fmtUsd(v, { cents: true })
}

function marginTone(pct: number | null): string {
  if (pct === null) return 'text-ink-3'
  return pct < 0 ? 'text-crit' : pct < 0.5 ? 'text-warn' : 'text-good'
}

export function MarginPage() {
  const { data, error, loading, retry } = useMargin()
  if (error && !data) return <ErrorCard message={error} onRetry={retry} />
  if (!data)
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  const t = data.total
  return (
    <Reloading active={loading}>
      <div className="space-y-10">
        <Section id="margin" title="Revenue against GPU cost" subtitle={`${fmtRange(data.from, data.to)} · runs and free analyze jobs by the day they were created`} actions={<MarginInfo />}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Revenue collected" value={money(t.revenue)} hint={`billed ${money(t.billed)} · ${money(t.outstanding)} not collected yet`} />
            <Stat label="GPU cost" value={money(t.cost)} hint={`${fmtCount(t.runs)} runs · ${fmtCount(t.analyses)} analyze jobs${t.without_cost ? ` · ${t.without_cost} without a cost` : ''}`} />
            <Stat label="Gross margin" value={money(t.margin)} tone={t.margin < 0 ? 'bad' : 'good'} hint="revenue − GPU cost" />
            <Stat label="Gross margin %" value={fmtRatio(t.margin_pct)} hint={`on what was billed: ${fmtRatio(t.billed_margin_pct)}`} />
            <Stat label="Waived" value={money(t.waived)} hint={`${fmtCount(t.waived_runs)} runs run free of charge; their cost stays in`} tone={t.waived_runs ? 'bad' : undefined} />
          </div>
        </Section>
        <Section id="margin-steps" title="By step and preset" subtitle="Which step and which output size pays for its GPUs">
          <div className="space-y-3">
            <MarginTable title="Per step" rows={data.by_step.map((r) => ({ key: r.run_type, label: runTypeLabel(r.run_type), row: r }))} />
            <MarginTable
              title="Per step and preset"
              rows={data.by_preset.map((r) => ({ key: `${r.run_type}:${r.preset}`, label: r.run_type === 'analyze' ? runTypeLabel(r.run_type) : `${runTypeLabel(r.run_type)} · ${r.preset}`, row: r }))}
            />
          </div>
        </Section>
        <Section id="margin-days" title="Over time" subtitle={`per ${data.grain}`}>
          <Card>
            <CardContent className="p-4">
              <ChartFrame title="Revenue, GPU cost and margin" hint="bars side by side, margin dashed">
                <div style={{ height: H }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={data.series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
                      <CartesianGrid vertical={false} strokeDasharray="0" />
                      <XAxis dataKey="date" {...AXIS} tickFormatter={(v: string) => fmtDay(v, data.grain)} minTickGap={28} />
                      <YAxis {...AXIS} width={48} tickFormatter={(v: number) => fmtAxis(v, 'usd')} />
                      <RTooltip cursor={{ fill: 'rgb(var(--surface-2))' }} content={(p) => <ChartTooltip {...p} series={SERIES} title={(l) => fmtDayLong(l, data.grain)} />} />
                      <Bar dataKey="revenue" fill={C.s1} radius={[2, 2, 0, 0]} isAnimationActive={false} />
                      <Bar dataKey="cost" fill={C.s2} radius={[2, 2, 0, 0]} isAnimationActive={false} />
                      <Line type="linear" dataKey="margin" stroke={C.ink3} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <Legend series={SERIES} />
              </ChartFrame>
            </CardContent>
          </Card>
        </Section>
        <Section id="margin-runs" title="Waived and costliest runs" subtitle="In the range">
          <div className="space-y-3">
            <Card>
              <CardContent className="p-0">
                <TableTitle title="Waived runs" hint="run free of charge after the fact" />
                {data.waived.length === 0 ? (
                  <Empty>No waived runs in the range.</Empty>
                ) : (
                  <Table inset>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Created</TableHead>
                        <TableHead>Run</TableHead>
                        <TableHead>Step</TableHead>
                        <TableHead className="text-right">Waived</TableHead>
                        <TableHead className="text-right">GPU cost</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Account</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.waived.map((w) => (
                        <TableRow key={w.id} className="align-top text-xs">
                          <TableCell className="num whitespace-nowrap">{fmtDateTime(w.created_at)}</TableCell>
                          <TableCell className="font-mono text-[0.7rem]">{w.id}</TableCell>
                          <TableCell>
                            {runTypeLabel(w.run_type)} · {w.preset}
                          </TableCell>
                          <TableCell className="num text-right">{money(w.waived)}</TableCell>
                          <TableCell className="num text-right">{money(w.cost_usd)}</TableCell>
                          <TableCell className="max-w-[24rem] text-ink-2">{w.reason ?? EM_DASH}</TableCell>
                          <TableCell className="font-mono text-[0.7rem]" title={w.uid}>
                            {shortId(w.uid)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-0">
                <TableTitle title="Costliest runs" hint="by GPU cost" />
                {data.top_cost.length === 0 ? (
                  <Empty>No run with a recorded cost in the range.</Empty>
                ) : (
                  <Table inset>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Created</TableHead>
                        <TableHead>Run</TableHead>
                        <TableHead>Step</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead className="text-right">Billed</TableHead>
                        <TableHead className="text-right">Collected</TableHead>
                        <TableHead className="text-right">GPU cost</TableHead>
                        <TableHead className="text-right">Margin</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.top_cost.map((r) => {
                        const m = r.revenue - (r.cost_usd ?? 0)
                        return (
                          <TableRow key={r.id} className="text-xs">
                            <TableCell className="num whitespace-nowrap">{fmtDateTime(r.created_at)}</TableCell>
                            <TableCell className="font-mono text-[0.7rem]">{r.id}</TableCell>
                            <TableCell>
                              {runTypeLabel(r.run_type)} · {r.preset}
                            </TableCell>
                            <TableCell>
                              <Badge variant={r.state === 'succeeded' ? 'good' : 'warn'}>{r.state}</Badge>
                            </TableCell>
                            <TableCell className="num text-right">{money(r.billed)}</TableCell>
                            <TableCell className="num text-right">{money(r.revenue)}</TableCell>
                            <TableCell className="num text-right">{money(r.cost_usd)}</TableCell>
                            <TableCell className={cn('num text-right', m < 0 ? 'text-crit' : 'text-ink')}>{money(m)}</TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </Section>
      </div>
    </Reloading>
  )
}

function MarginTable({ title, rows }: { title: string; rows: { key: string; label: string; row: MarginRow }[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <TableTitle title={title} />
        {rows.length === 0 ? (
          <Empty>Nothing ran in the range.</Empty>
        ) : (
          <Table inset>
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead className="text-right">Runs</TableHead>
                <TableHead className="text-right">Billed</TableHead>
                <TableHead className="text-right">Collected</TableHead>
                <TableHead className="text-right">GPU cost</TableHead>
                <TableHead className="text-right">Cost per run</TableHead>
                <TableHead className="text-right">Gross margin</TableHead>
                <TableHead className="text-right">Margin %</TableHead>
                <TableHead className="text-right">Waived</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ key, label, row: r }) => (
                <TableRow key={key} className="text-xs">
                  <TableCell className="font-medium text-ink">{label}</TableCell>
                  <TableCell className="num text-right">
                    {fmtCount(r.runs + r.analyses)}
                    {r.without_cost ? <span className="ml-1 text-ink-3" title="runs with no recorded GPU cost (failed and canceled runs mostly)">({r.without_cost} no cost)</span> : null}
                  </TableCell>
                  <TableCell className="num text-right">{money(r.billed)}</TableCell>
                  <TableCell className="num text-right">{money(r.revenue)}</TableCell>
                  <TableCell className="num text-right">{money(r.cost)}</TableCell>
                  <TableCell className="num text-right">{money(r.cost_per_item)}</TableCell>
                  <TableCell className={cn('num text-right', r.margin < 0 ? 'text-crit' : 'text-ink')}>{money(r.margin)}</TableCell>
                  <TableCell className={cn('num text-right font-medium', marginTone(r.margin_pct))}>{r.margin_pct === null ? (r.cost > 0 ? 'free' : EM_DASH) : fmtRatio(r.margin_pct)}</TableCell>
                  <TableCell className="num text-right">{r.waived ? `${money(r.waived)} (${r.waived_runs})` : EM_DASH}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function MarginInfo() {
  return (
    <InfoButton title="Margin">
      <ul>
        <li><b>Revenue collected</b>: money that reached Stripe for the run (a batched run’s share once its batch is paid). <b>Billed</b>: the quote of every succeeded run, collected or not; failed and canceled runs are never charged.</li>
        <li><b>GPU cost</b>: Modal’s cost the gateway records on the run (modal.cost_usd), plus each project’s free analyze job (analyze.cost_usd). Cloud Run, storage, egress and Stripe’s fees are not in it.</li>
        <li><b>Gross margin</b> = revenue − GPU cost; <b>margin %</b> = that ÷ revenue. “free” means the step costs GPU money and brings none (photos, analyze).</li>
        <li><b>Waived</b>: runs the owner made free after the fact (the 2026-10-27 depth-queue incident); they count as cost with zero revenue.</li>
        <li>Runs without a recorded cost (mostly failed or canceled ones) count as zero cost, so the cost is a floor.</li>
        <li>Both sides are dated by the day the run was created, so a run and its batch charge never land in different periods.</li>
      </ul>
      <HowToRead>A step below 50 % is amber, below zero red: that is where the price or the pipeline needs a look.</HowToRead>
    </InfoButton>
  )
}
