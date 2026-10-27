import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import type { Site, SiteRow } from '@/api/types'
import { AXIS, BarList, C, ChartFrame, ChartTooltip, Legend, type SeriesDef } from '@/components/charts'
import { HowToRead, InfoButton } from '@/components/InfoModal'
import { Empty, ErrorCard, Reloading, Section, Stat, TableTitle } from '@/components/Section'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useSite } from '@/hooks/useApi'
import { EM_DASH, fmtCount, fmtDay, fmtDayLong, fmtDec, fmtDelta, fmtRange, fmtRatio, pctDelta } from '@/lib/format'
import { cn } from '@/lib/utils'

const H = 260
const WEEKLY_AFTER_DAYS = 92

const DAILY_SERIES: SeriesDef[] = [
  { key: 'visitors', label: 'Visitors', color: C.s1 },
  { key: 'pageviews', label: 'Pageviews', color: C.s3 },
  { key: 'events', label: 'Custom events', color: C.ink3, dashed: true },
]

function delta(cur: number | null, prev: number | null): string {
  const d = pctDelta(cur, prev)
  return d === null ? `prev ${EM_DASH}` : `${fmtDelta(d)} vs previous`
}

/** The website's Vercel Web Analytics, the same source and layout as the Spatial Video Studio KPI's
 *  Website page, without the App Store's web-referrer numbers (this product has no store listing). */
export function WebsitePage() {
  const { data, error, loading, retry } = useSite()
  if (error && !data) return <ErrorCard message={error} onRetry={retry} />
  if (!data)
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  const c = data.current
  const p = data.previous
  return (
    <Reloading active={loading}>
      <Section
        id="website"
        title="Website"
        subtitle={`${fmtRange(data.from, data.to)} · compared with ${fmtRange(p.from, p.to)} · Vercel Web Analytics of the stereo3d-studio project`}
        actions={<SiteInfo />}
      >
        <div className="space-y-6">
          {data.notes.length > 0 ? (
            <Card className="border-dashed bg-surface/60">
              <CardContent className="space-y-1 p-4 text-sm text-ink-2">
                {data.notes.map((n) => (
                  <p key={n}>{n}</p>
                ))}
              </CardContent>
            </Card>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label="Visitors" value={fmtCount(c.visitors)} previous={delta(c.visitors, p.visitors)} hint="Per day and page, added up: a returning visitor counts again" />
            <Stat
              label="Pageviews"
              value={fmtCount(c.pageviews)}
              previous={delta(c.pageviews, p.pageviews)}
              hint={c.pages_per_visitor === null ? undefined : `${fmtDec(c.pages_per_visitor)} pages per visitor`}
            />
            <Stat label="Custom events" value={fmtCount(c.events)} previous={delta(c.events, p.events)} hint="track() calls: uploads, CTA clicks, onboarding" />
          </div>
          <Card>
            <CardContent className="p-4">
              <DailyChart data={data} />
            </CardContent>
          </Card>
          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardContent className="p-0">
                <DimTable title="Countries" head="Country" rows={data.countries} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-0">
                <DimTable title="Where visitors come from" head="Referrer" rows={data.referrers} />
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
            <Card>
              <CardContent className="p-0">
                <DimTable title="Top pages" head="Page" rows={data.pages} mono />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <ChartFrame title="Devices" hint="share of pageviews">
                  <BarList
                    items={data.devices.map((r) => ({ key: r.value || 'unknown', label: r.label, value: r.share ?? 0 }))}
                    format={(v) => fmtRatio(v)}
                    max={1}
                    emptyText="No visits in the range"
                  />
                </ChartFrame>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardContent className="p-0">
              <TableTitle title="Custom events" hint="by name" />
              {data.events.length === 0 ? (
                <Empty>No custom events in the range.</Empty>
              ) : (
                <Table inset>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead className="text-right">Count</TableHead>
                      <TableHead className="text-right">Visitors</TableHead>
                      <TableHead className="text-right">Share</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.events.map((r) => (
                      <TableRow key={r.value} className="text-xs">
                        <TableCell className="font-mono text-[0.7rem]">{r.label}</TableCell>
                        <TableCell className="num text-right text-ink">{fmtCount(r.count ?? 0)}</TableCell>
                        <TableCell className="num text-right">{fmtCount(r.visitors ?? 0)}</TableCell>
                        <TableCell className="num text-right">{fmtRatio(r.share)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          {data.utm_sources.length > 0 ? (
            <Card>
              <CardContent className="p-0">
                <DimTable title="UTM sources" head="utm_source" rows={data.utm_sources} />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </Section>
    </Reloading>
  )
}

function SiteInfo() {
  return (
    <InfoButton title="Website">
      <ul>
        <li>Vercel’s cookieless Web Analytics of the web app (Vercel project stereo3d-studio), read once an hour, the last three days again each time.</li>
        <li><b>Visitors</b> are counted once per day and page; summing over days or rows counts a returning visitor again, so the breakdowns do not add up to the total.</li>
        <li><b>Custom events</b>: the app’s track() calls (upload_started, project_created, add_payment_info, the landing page’s CTA clicks…).</li>
        <li>Vercel answers only the last 366 days; the dashboard keeps what it loaded. UTM sources need the Web Analytics Plus add-on.</li>
      </ul>
      <HowToRead>Use it beside Overview: visitors and CTA clicks first, then new billing accounts and paying customers.</HowToRead>
    </InfoButton>
  )
}

function weekOf(day: string): string {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

function DailyChart({ data }: { data: Site }) {
  const weekly = data.series.length > WEEKLY_AFTER_DAYS
  let points = data.series
  if (weekly) {
    const out = new Map<string, { date: string; visitors: number; pageviews: number; events: number }>()
    for (const d of data.series) {
      const key = weekOf(d.date)
      const cur = out.get(key) ?? { date: key, visitors: 0, pageviews: 0, events: 0 }
      cur.visitors += d.visitors
      cur.pageviews += d.pageviews
      cur.events += d.events
      out.set(key, cur)
    }
    points = [...out.values()]
  }
  const grain = weekly ? 'week' : 'day'
  const any = points.some((p) => p.visitors || p.pageviews || p.events)
  return (
    <ChartFrame title={weekly ? 'Week by week' : 'Day by day'} hint="visitors and pageviews as bars, custom events dashed on the right">
      {!any ? (
        <p className="py-10 text-center text-sm text-ink-3">Nothing in the range.</p>
      ) : (
        <div style={{ height: H }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
              <CartesianGrid vertical={false} strokeDasharray="0" />
              <XAxis dataKey="date" {...AXIS} tickFormatter={(v: string) => fmtDay(v, grain)} minTickGap={28} />
              <YAxis yAxisId="left" {...AXIS} width={40} allowDecimals={false} tickFormatter={(v: number) => fmtCount(v)} />
              <YAxis yAxisId="right" orientation="right" {...AXIS} width={36} allowDecimals={false} tickFormatter={(v: number) => fmtCount(v)} />
              <RTooltip cursor={{ fill: 'rgb(var(--surface-2))' }} content={(p) => <ChartTooltip {...p} series={DAILY_SERIES} title={(l) => fmtDayLong(l, grain)} />} />
              <Bar yAxisId="left" dataKey="visitors" fill={C.s1} radius={[2, 2, 0, 0]} isAnimationActive={false} />
              <Bar yAxisId="left" dataKey="pageviews" fill={C.s3} radius={[2, 2, 0, 0]} isAnimationActive={false} />
              <Line yAxisId="right" type="linear" dataKey="events" stroke={C.ink3} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      <Legend series={DAILY_SERIES} />
    </ChartFrame>
  )
}

function DimTable({ title, head, rows, mono }: { title: string; head: string; rows: SiteRow[]; mono?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <TableTitle title={title} hint="by pageviews" />
      {rows.length === 0 ? (
        <Empty>No visits in the range.</Empty>
      ) : (
        <Table inset>
          <TableHeader>
            <TableRow>
              <TableHead>{head}</TableHead>
              <TableHead className="text-right">Visitors</TableHead>
              <TableHead className="text-right">Pageviews</TableHead>
              <TableHead className="text-right">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.value || '(none)'} className="text-xs">
                <TableCell className={cn('max-w-[22rem] truncate', mono && 'font-mono text-[0.7rem]')} title={r.label}>
                  {r.label}
                </TableCell>
                <TableCell className="num text-right">{fmtCount(r.visitors ?? 0)}</TableCell>
                <TableCell className="num text-right text-ink">{fmtCount(r.pageviews ?? 0)}</TableCell>
                <TableCell className="num text-right">{fmtRatio(r.share)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
