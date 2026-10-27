import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import type { Grain, Overview, Point } from '@/api/types'
import { AXIS, C, ChartFrame, ChartTooltip, Legend, type SeriesDef } from '@/components/charts'
import { CardGrid, KpiCard } from '@/components/KpiCard'
import { HowToRead, InfoButton } from '@/components/InfoModal'
import { Empty, ErrorCard, Reloading, Section, Stat, TableTitle } from '@/components/Section'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useOverview } from '@/hooks/useApi'
import { fmtAxis, fmtCount, fmtDateTime, fmtDay, fmtDayLong, fmtRange, fmtUsd } from '@/lib/format'
import { runTypeLabel, shortId } from '@/lib/labels'

const H = 240

const CASH_SERIES: SeriesDef[] = [
  { key: 'batch', label: 'Billing batches', color: C.s1, unit: 'usd' },
  { key: 'charge', label: 'Single charges', color: C.s2, unit: 'usd' },
  { key: 'hold_capture', label: 'Captured holds', color: C.s3, unit: 'usd' },
]
const PEOPLE_SERIES: SeriesDef[] = [
  { key: 'new_payers', label: 'New paying customers', color: C.s2 },
  { key: 'accounts', label: 'New billing accounts', color: C.s1 },
]
const RUN_SERIES: SeriesDef[] = [
  { key: 'depth_preview', label: 'Depth preview', color: C.s1 },
  { key: 'stereo_preview', label: 'Stereo preview', color: C.s2 },
  { key: 'production', label: 'Production', color: C.s3 },
  { key: 'image', label: 'Photo', color: C.s4 },
  { key: 'video', label: 'Video (mobile)', color: C.s5 },
]

export function OverviewPage() {
  const { data, error, loading, retry } = useOverview()
  if (error && !data) return <ErrorCard message={error} onRetry={retry} />
  if (!data)
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  return (
    <Reloading active={loading}>
      <div className="space-y-10">
        <Section
          id="overview"
          title="This period"
          subtitle={`${fmtRange(data.from, data.to)} · deltas vs ${fmtRange(data.previous.from, data.previous.to)}`}
          actions={<CardsInfo />}
        >
          <CardGrid>
            {data.cards.map((c) => (
              <KpiCard key={c.key} card={c} />
            ))}
          </CardGrid>
        </Section>
        <CashSection data={data} />
        <RunsSection data={data} />
        <PayersSection data={data} />
      </div>
    </Reloading>
  )
}

function CardsInfo() {
  return (
    <InfoButton title="The period's numbers">
      <ul>
        <li><b>Cash collected</b>: money that reached Stripe in the range, on the day it was collected: paid billing batches (one charge for several runs), runs charged on their own, and captured card holds. Waived runs collect nothing. Refunds made by hand in Stripe are not in Firestore and are not subtracted.</li>
        <li><b>Paying customers</b>: people with at least one payment in the range. <b>New paying customers</b>: people whose first payment ever falls in the range.</li>
        <li><b>New billing accounts</b>: customers records created in the range (made when someone first enters the billing flow, card or not).</li>
        <li><b>Average per payer</b>: cash collected ÷ paying customers.</li>
        <li><b>Runs</b>: conversions created in the range, every step and photos included; <b>paid runs succeeded</b> are those with a price above zero that succeeded.</li>
      </ul>
      <HowToRead>Compare each card with the previous period of the same length; the arrow is green when the number grew.</HowToRead>
    </InfoButton>
  )
}

function StackedBars({ points, series, grain, unit = 'count', line }: { points: Point[]; series: SeriesDef[]; grain: Grain; unit?: 'usd' | 'count'; line?: SeriesDef }) {
  const all = line ? [...series, line] : series
  return (
    <>
      <div style={{ height: H }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} strokeDasharray="0" />
            <XAxis dataKey="date" {...AXIS} tickFormatter={(v: string) => fmtDay(v, grain)} minTickGap={28} />
            <YAxis {...AXIS} width={48} allowDecimals={unit === 'usd'} tickFormatter={(v: number) => fmtAxis(v, unit)} />
            <RTooltip cursor={{ fill: 'rgb(var(--surface-2))' }} content={(p) => <ChartTooltip {...p} series={all} title={(l) => fmtDayLong(l, grain)} />} />
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} stackId="a" fill={s.color} radius={i === series.length - 1 ? [2, 2, 0, 0] : undefined} isAnimationActive={false} />
            ))}
            {line ? <Line type="linear" dataKey={line.key} stroke={line.color} strokeWidth={1.5} dot={false} isAnimationActive={false} /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <Legend series={all} />
    </>
  )
}

function CashSection({ data }: { data: Overview }) {
  const l = data.lifetime
  const owed = l.owed_in_batches + l.owed_pending
  return (
    <Section id="cash" title="Cash and customers" subtitle="All time beside the period: what came in, from how many people, and what is still owed" actions={<CashInfo />}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Cash collected, all time" value={fmtUsd(l.cash, { cents: true })} hint={`${fmtCount(l.payments)} payments`} />
          <Stat label="Paying customers, all time" value={fmtCount(l.payers)} hint={`of ${fmtCount(l.accounts)} billing accounts · ${fmtCount(l.accounts_with_card)} with a card`} />
          <Stat label="Lifetime value per payer" value={fmtUsd(l.per_payer, { cents: true })} hint="all cash ÷ everyone who ever paid" />
          <Stat
            label="Owed, not collected yet"
            value={fmtUsd(owed, { cents: true })}
            hint={`${fmtUsd(l.owed_in_batches, { cents: true })} in open batches · ${fmtUsd(l.owed_pending, { cents: true })} awaiting a charge`}
          />
          <Stat
            label="Refused by the card"
            value={fmtUsd(l.owed_refused, { cents: true })}
            tone={l.owed_refused > 0 ? 'bad' : undefined}
            hint="succeeded runs whose charge failed; the account is blocked until settled"
          />
        </div>
        {Math.abs(l.gateway_total - l.cash) >= 0.01 ? (
          <p className="text-xs text-ink-3">
            The gateway’s own running total (customers.lifetime_paid_cents) is {fmtUsd(l.gateway_total, { cents: true })}, {fmtUsd(Math.abs(l.cash - l.gateway_total), { cents: true })}{' '}
            {l.cash > l.gateway_total ? 'below' : 'above'} the payment records: the Payers table shows whom it differs for.
          </p>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardContent className="p-4">
              <ChartFrame title="Cash collected" hint={`per ${data.grain}, by how it was collected`}>
                <StackedBars points={data.cash_series} series={CASH_SERIES} grain={data.grain} unit="usd" />
              </ChartFrame>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <ChartFrame title="New customers" hint={`per ${data.grain}`}>
                <StackedBars points={data.people_series} series={[PEOPLE_SERIES[1]]} grain={data.grain} line={PEOPLE_SERIES[0]} />
              </ChartFrame>
            </CardContent>
          </Card>
        </div>
      </div>
    </Section>
  )
}

function CashInfo() {
  return (
    <InfoButton title="Cash and customers">
      <ul>
        <li><b>Billing batches</b>: succeeded pay-as-you-go runs go on the user’s running tab, charged as one payment when its window ends, it reaches the tier cap, or the user pays now. A batch counts once, on the day it was charged.</li>
        <li><b>Single charges</b>: runs charged one by one (pay-as-you-go before batching, and the web 3DS fallback). <b>Captured holds</b>: the mobile PaymentSheet flow, a card hold captured on success.</li>
        <li><b>Lifetime value per payer</b>: every payment ever ÷ everyone who ever paid.</li>
        <li><b>Owed</b>: succeeded runs not paid yet, in an open batch or waiting for the charge. <b>Refused</b>: their charge failed (charge_failed or capture_failed).</li>
        <li><b>New billing accounts</b>: customers records created; <b>new paying customers</b>: first payment ever in that bucket.</li>
      </ul>
      <HowToRead>The bars are money on the day it arrived, not on the day the run was made; Margin dates revenue by the run.</HowToRead>
    </InfoButton>
  )
}

function RunsSection({ data }: { data: Overview }) {
  const states = data.states
  return (
    <Section id="runs" title="Runs by step and state" subtitle="Conversions created in the range, every step of the pro pipeline and the photo and mobile runs">
      <div className="grid gap-3 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardContent className="p-4">
            <ChartFrame title="Runs" hint={`per ${data.grain}, by step`}>
              <StackedBars points={data.run_series} series={RUN_SERIES} grain={data.grain} />
            </ChartFrame>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-0">
            <TableTitle title="By step and state" hint="runs in the range" />
            {data.by_step.length === 0 ? (
              <Empty>No runs in the range.</Empty>
            ) : (
              <Table inset>
                <TableHeader>
                  <TableRow>
                    <TableHead>Step</TableHead>
                    {states.map((s) => (
                      <TableHead key={s} className="text-right capitalize">
                        {s}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">All</TableHead>
                    <TableHead className="text-right">Billed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.by_step.map((r) => (
                    <TableRow key={r.run_type} className="text-xs">
                      <TableCell className="font-medium text-ink">{runTypeLabel(r.run_type)}</TableCell>
                      {states.map((s) => (
                        <TableCell key={s} className="num text-right">
                          {r.states[s] ? fmtCount(r.states[s]) : <span className="text-ink-3">0</span>}
                        </TableCell>
                      ))}
                      <TableCell className="num text-right text-ink">{fmtCount(r.total)}</TableCell>
                      <TableCell className="num text-right">{fmtUsd(r.billed_usd, { cents: true })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </Section>
  )
}

function PayersSection({ data }: { data: Overview }) {
  return (
    <Section id="payers" title="Payers" subtitle="Everyone who ever paid, all time, largest first">
      <Card>
        <CardContent className="p-0">
          {data.payers.length === 0 ? (
            <Empty>Nobody has paid yet.</Empty>
          ) : (
            <Table inset>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Billing account since</TableHead>
                  <TableHead>First paid</TableHead>
                  <TableHead>Last paid</TableHead>
                  <TableHead className="text-right">Payments</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Gateway total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.payers.map((p) => (
                  <TableRow key={p.uid} className="text-xs">
                    <TableCell className="font-mono text-[0.7rem]" title={p.uid}>
                      {shortId(p.uid)}
                    </TableCell>
                    <TableCell className="num">{fmtDateTime(p.account_at)}</TableCell>
                    <TableCell className="num">{fmtDateTime(p.first_paid_at)}</TableCell>
                    <TableCell className="num">{fmtDateTime(p.last_paid_at)}</TableCell>
                    <TableCell className="num text-right">{fmtCount(p.payments)}</TableCell>
                    <TableCell className="num text-right">{fmtCount(p.runs)}</TableCell>
                    <TableCell className="num text-right font-medium text-ink">{fmtUsd(p.paid, { cents: true })}</TableCell>
                    <TableCell className={Math.abs(p.gateway_total - p.paid) >= 0.01 ? 'num text-right text-warn' : 'num text-right text-ink-3'}>
                      {fmtUsd(p.gateway_total, { cents: true })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </Section>
  )
}
