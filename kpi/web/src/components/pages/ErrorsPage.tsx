import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import type { Errors, RunRow } from '@/api/types'
import { AXIS, C, ChartFrame, ChartTooltip, Legend, type SeriesDef } from '@/components/charts'
import { HowToRead, InfoButton } from '@/components/InfoModal'
import { Empty, ErrorCard, Reloading, Section, Stat, TableTitle } from '@/components/Section'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useErrors } from '@/hooks/useApi'
import { EM_DASH, fmtCount, fmtDateTime, fmtDay, fmtDayLong, fmtRange, fmtRatio, fmtSeconds, fmtUsd } from '@/lib/format'
import { runTypeLabel, shortId } from '@/lib/labels'

const H = 240
const SERIES: SeriesDef[] = [
  { key: 'succeeded', label: 'Succeeded', color: C.s1 },
  { key: 'failed', label: 'Failed', color: C.crit },
  { key: 'canceled', label: 'Canceled', color: C.s4 },
  { key: 'failure_rate', label: 'Failure rate', color: C.ink3, unit: 'ratio', dashed: true },
]

export function ErrorsPage() {
  const { data, error, loading, retry } = useErrors()
  if (error && !data) return <ErrorCard message={error} onRetry={retry} />
  if (!data)
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  return (
    <Reloading active={loading}>
      <div className="space-y-10">
        <FailureSection data={data} />
        <Section id="failed" title="Failed runs" subtitle={`${fmtRange(data.from, data.to)} · newest first · the user was not charged for any of them`}>
          <div className="space-y-3">
            <Card>
              <CardContent className="p-0">
                <TableTitle title="By error code and stage" hint="failed runs in the range" />
                {data.codes.length === 0 ? (
                  <Empty>No failed runs in the range.</Empty>
                ) : (
                  <Table inset>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Error code</TableHead>
                        <TableHead>Stage when it failed</TableHead>
                        <TableHead className="text-right">Runs</TableHead>
                        <TableHead className="text-right">Last</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.codes.map((c) => (
                        <TableRow key={`${c.code}:${c.stage}`} className="text-xs">
                          <TableCell className="font-mono text-[0.7rem]">{c.code}</TableCell>
                          <TableCell className="font-mono text-[0.7rem]">{c.stage}</TableCell>
                          <TableCell className="num text-right text-ink">{fmtCount(c.runs)}</TableCell>
                          <TableCell className="num text-right">{fmtDateTime(c.last_at)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
            <RunTable rows={data.failed} empty="No failed runs in the range." showError />
          </div>
        </Section>
        <OverdueSection data={data} />
        <Section id="canceled" title="Canceled and expired runs" subtitle={`${fmtRange(data.from, data.to)} · canceled by the user, or never paid (expired); never charged`}>
          <RunTable rows={data.canceled} empty="No canceled or expired runs in the range." />
        </Section>
        <BillingSection data={data} />
      </div>
    </Reloading>
  )
}

function FailureSection({ data }: { data: Errors }) {
  const t = data.totals
  return (
    <Section id="failure" title="Failure rates" subtitle={`${fmtRange(data.from, data.to)} · runs by the day they were created`} actions={<FailureInfo />}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Failure rate" value={fmtRatio(t.failure_rate)} tone={t.failure_rate && t.failure_rate > 0.05 ? 'bad' : undefined} hint={`${fmtCount(t.failed)} failed of ${fmtCount(t.succeeded + t.failed)} finished`} />
          <Stat label="Canceled" value={fmtCount(t.canceled)} hint={`${fmtRatio(t.cancel_rate)} of ended runs`} />
          <Stat label="Expired" value={fmtCount(t.expired)} hint="never paid (hold mode)" />
          <Stat label="Still running" value={fmtCount(t.running)} hint="created, paid or processing" />
          <Stat label="User reports" value={fmtCount(t.reports)} hint="“this run is stuck”, in the range" />
        </div>
        <div className="grid gap-3 lg:grid-cols-[3fr_2fr]">
          <Card>
            <CardContent className="p-4">
              <ChartFrame title="Ended runs" hint={`per ${data.grain}; failure rate on the right`}>
                <div style={{ height: H }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={data.series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
                      <CartesianGrid vertical={false} strokeDasharray="0" />
                      <XAxis dataKey="date" {...AXIS} tickFormatter={(v: string) => fmtDay(v, data.grain)} minTickGap={28} />
                      <YAxis yAxisId="left" {...AXIS} width={40} allowDecimals={false} />
                      <YAxis yAxisId="right" orientation="right" {...AXIS} width={40} domain={[0, 1]} tickFormatter={(v: number) => fmtRatio(v, 0)} />
                      <RTooltip cursor={{ fill: 'rgb(var(--surface-2))' }} content={(p) => <ChartTooltip {...p} series={SERIES} title={(l) => fmtDayLong(l, data.grain)} />} />
                      <Bar yAxisId="left" dataKey="succeeded" stackId="a" fill={C.s1} isAnimationActive={false} />
                      <Bar yAxisId="left" dataKey="failed" stackId="a" fill={C.crit} isAnimationActive={false} />
                      <Bar yAxisId="left" dataKey="canceled" stackId="a" fill={C.s4} radius={[2, 2, 0, 0]} isAnimationActive={false} />
                      <Line yAxisId="right" type="linear" dataKey="failure_rate" stroke={C.ink3} strokeDasharray="4 3" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <Legend series={SERIES} />
              </ChartFrame>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0">
              <TableTitle title="Per step" hint="runs created in the range" />
              {data.by_step.length === 0 ? (
                <Empty>No runs in the range.</Empty>
              ) : (
                <Table inset>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Step</TableHead>
                      <TableHead className="text-right">Succeeded</TableHead>
                      <TableHead className="text-right">Failed</TableHead>
                      <TableHead className="text-right">Failure rate</TableHead>
                      <TableHead className="text-right">Canceled</TableHead>
                      <TableHead className="text-right">Running</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.by_step.map((r) => (
                      <TableRow key={r.run_type} className="text-xs">
                        <TableCell className="font-medium text-ink">{runTypeLabel(r.run_type)}</TableCell>
                        <TableCell className="num text-right">{fmtCount(r.succeeded)}</TableCell>
                        <TableCell className={r.failed ? 'num text-right text-crit' : 'num text-right'}>{fmtCount(r.failed)}</TableCell>
                        <TableCell className="num text-right text-ink">{fmtRatio(r.failure_rate)}</TableCell>
                        <TableCell className="num text-right">{fmtCount(r.canceled)}</TableCell>
                        <TableCell className="num text-right">{fmtCount(r.running)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </Section>
  )
}

function FailureInfo() {
  return (
    <InfoButton title="Failure rates">
      <ul>
        <li><b>Failure rate</b>: failed ÷ (succeeded + failed) among runs created in the range. Cancellations are left out of it: the user chose to stop.</li>
        <li><b>Canceled</b>: stopped by the user. <b>Expired</b>: a hold-mode run that was never paid. Neither is charged.</li>
        <li><b>Still running</b>: created (waiting for a 3DS answer), paid (waiting for a GPU) or processing.</li>
        <li>A run is counted on the day it was <b>created</b> (UTC), whatever day it ended.</li>
      </ul>
      <HowToRead>A step whose failure rate rises is where to look first; the tables below give the stage and the error.</HowToRead>
    </InfoButton>
  )
}

function RunTable({ rows, empty, showError }: { rows: RunRow[]; empty: string; showError?: boolean }) {
  return (
    <Card>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <Empty>{empty}</Empty>
        ) : (
          <Table inset>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Step</TableHead>
                <TableHead>Preset</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead className="text-right">Progress</TableHead>
                {showError ? <TableHead>Error</TableHead> : <TableHead>State</TableHead>}
                <TableHead className="text-right">Quote</TableHead>
                <TableHead>Account</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className="align-top text-xs">
                  <TableCell className="num whitespace-nowrap">{fmtDateTime(r.created_at)}</TableCell>
                  <TableCell className="font-mono text-[0.7rem]">{r.id}</TableCell>
                  <TableCell>{runTypeLabel(r.run_type)}</TableCell>
                  <TableCell>{r.preset}</TableCell>
                  <TableCell className="max-w-[12rem] truncate font-mono text-[0.7rem]" title={r.stage ?? ''}>
                    {r.stage ?? EM_DASH}
                  </TableCell>
                  <TableCell className="num text-right">{r.progress === null ? EM_DASH : fmtRatio(r.progress, 0)}</TableCell>
                  {showError ? (
                    <TableCell className="max-w-[28rem]">
                      <span className="font-mono text-[0.7rem] text-crit">{r.error_code ?? EM_DASH}</span>
                      {r.error_detail ? (
                        <p className="mt-0.5 line-clamp-2 text-[0.7rem] text-ink-2" title={r.error_detail}>
                          {r.error_detail}
                        </p>
                      ) : null}
                    </TableCell>
                  ) : (
                    <TableCell>
                      <Badge variant={r.state === 'canceled' ? 'neutral' : 'warn'}>{r.state}</Badge>
                    </TableCell>
                  )}
                  <TableCell className="num text-right">{fmtUsd(r.quote, { cents: true })}</TableCell>
                  <TableCell className="font-mono text-[0.7rem]" title={r.uid}>
                    {shortId(r.uid)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function OverdueSection({ data }: { data: Errors }) {
  return (
    <Section id="overdue" title="Overdue runs and user reports" subtitle="All time · the gateway flags a run once it is well past its estimate, and users can report a stuck run" actions={<OverdueInfo />}>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardContent className="p-0">
            <TableTitle title="Overdue runs" hint={`${data.overdue.filter((o) => o.overdue_now).length} overdue right now`} />
            {data.overdue.length === 0 ? (
              <Empty>No run has been flagged overdue, and none is overdue now. Runs from before the gateway added the flag never carry it.</Empty>
            ) : (
              <Table inset>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Step</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead className="text-right">Estimate</TableHead>
                    <TableHead>Flagged</TableHead>
                    <TableHead>Now</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.overdue.map((o) => (
                    <TableRow key={o.id} className="text-xs">
                      <TableCell className="font-mono text-[0.7rem]">{o.id}</TableCell>
                      <TableCell>{runTypeLabel(o.run_type)}</TableCell>
                      <TableCell className="max-w-[10rem] truncate font-mono text-[0.7rem]" title={o.stage ?? ''}>
                        {o.stage ?? EM_DASH}
                      </TableCell>
                      <TableCell className="num text-right">{o.expected_seconds ? fmtSeconds(o.expected_seconds) : 'none'}</TableCell>
                      <TableCell className="num">{fmtDateTime(o.alerted_at)}</TableCell>
                      <TableCell>
                        {o.overdue_now ? <Badge variant="crit">running {fmtSeconds(o.running_seconds)}</Badge> : <Badge>{o.state}</Badge>}
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
            <TableTitle title="User reports" hint="newest first" />
            {data.reports.length === 0 ? (
              <Empty>No user has reported a run yet. “Report it” is new in the web app; older runs could not be reported.</Empty>
            ) : (
              <Table inset>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Run</TableHead>
                    <TableHead>Step</TableHead>
                    <TableHead>State now</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.reports.map((r, i) => (
                    <TableRow key={`${r.conversion_id}:${i}`} className="align-top text-xs">
                      <TableCell className="num whitespace-nowrap">{fmtDateTime(r.at)}</TableCell>
                      <TableCell className="font-mono text-[0.7rem]">{r.conversion_id}</TableCell>
                      <TableCell>{runTypeLabel(r.run_type)}</TableCell>
                      <TableCell>{r.state}</TableCell>
                      <TableCell className="max-w-[20rem] whitespace-pre-wrap text-ink-2">{r.note ?? EM_DASH}</TableCell>
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

function OverdueInfo() {
  return (
    <InfoButton title="Overdue runs and user reports">
      <ul>
        <li><b>Overdue</b> is the gateway’s rule (gateway/internal/api/overdue.go): a paid or processing run past its estimate plus the estimate again as slack, the slack kept between 15 minutes and an hour; 45 minutes without an estimate. The clock starts at GPU submission.</li>
        <li><b>Flagged</b>: when the gateway posted its Slack alert (support.overdue_alerted_at). <b>Now</b>: overdue at the time of the last ingest, flagged or not.</li>
        <li><b>User reports</b>: “Report it” in the web app (support.reports). Reporters’ emails are not copied into the dashboard.</li>
      </ul>
      <HowToRead>A run overdue right now needs a look in Modal; a report on a run that later succeeded still tells you the wait was too long.</HowToRead>
    </InfoButton>
  )
}

function BillingSection({ data }: { data: Errors }) {
  return (
    <Section id="billing" title="Billing problems" subtitle="All time, as they stand now: charges a card refused, captures that failed, batches stuck or failed">
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardContent className="p-0">
            <TableTitle title="Runs" hint="charge_failed, capture_failed, cancel_failed, or a settle error" />
            {data.billing.length === 0 ? (
              <Empty>No billing problem on any run.</Empty>
            ) : (
              <Table inset>
                <TableHeader>
                  <TableRow>
                    <TableHead>Created</TableHead>
                    <TableHead>Run</TableHead>
                    <TableHead>Step</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead className="text-right">Quote</TableHead>
                    <TableHead>Account</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.billing.map((b) => (
                    <TableRow key={b.id} className="align-top text-xs">
                      <TableCell className="num whitespace-nowrap">{fmtDateTime(b.created_at)}</TableCell>
                      <TableCell className="font-mono text-[0.7rem]">{b.id}</TableCell>
                      <TableCell>{runTypeLabel(b.run_type)}</TableCell>
                      <TableCell>
                        <Badge variant="warn">{b.pi_status || 'none'}</Badge>
                        {b.settle_error ? <p className="mt-0.5 line-clamp-2 text-[0.7rem] text-ink-2" title={b.settle_error}>{b.settle_error}</p> : null}
                      </TableCell>
                      <TableCell className="num text-right">{fmtUsd(b.quote, { cents: true })}</TableCell>
                      <TableCell className="font-mono text-[0.7rem]" title={b.uid}>
                        {shortId(b.uid)}
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
            <TableTitle title="Batches" hint="failed, or charging for over an hour" />
            {data.batches.length === 0 ? (
              <Empty>No failed or stuck batch.</Empty>
            ) : (
              <Table inset>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">Runs</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Closed</TableHead>
                    <TableHead>Account</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.batches.map((b) => (
                    <TableRow key={b.id} className="align-top text-xs">
                      <TableCell className="font-mono text-[0.7rem]">{b.id}</TableCell>
                      <TableCell>
                        <Badge variant="crit">{b.state}</Badge>
                        {b.settle_error ? <p className="mt-0.5 line-clamp-2 text-[0.7rem] text-ink-2" title={b.settle_error}>{b.settle_error}</p> : null}
                      </TableCell>
                      <TableCell className="num text-right">{fmtCount(b.runs)}</TableCell>
                      <TableCell className="num text-right">{fmtUsd(b.total, { cents: true })}</TableCell>
                      <TableCell className="num whitespace-nowrap">{fmtDateTime(b.closed_at)}</TableCell>
                      <TableCell className="font-mono text-[0.7rem]" title={b.uid}>
                        {shortId(b.uid)}
                      </TableCell>
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
