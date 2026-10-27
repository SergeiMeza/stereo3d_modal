// The API's shapes (backend/kpi/api.py). Money is USD, dates are UTC days (YYYY-MM-DD).

export type Grain = 'day' | 'week' | 'month'
export type Unit = 'usd' | 'count' | 'ratio'

export interface SourceStatus {
  id: string
  label: string
  status: 'ok' | 'pending' | 'error' | 'never' | 'skipped'
  last_run: string | null
  detail: string | null
  from: string | null
  to: string | null
}

export interface Meta {
  generated_at: string
  currency: string
  timezone: string
  app: { name: string; firestore_env: string }
  sources: SourceStatus[]
  other_currency_records: number
}

export interface IngestRun {
  started: boolean
  detail: string
}

export interface KpiCard {
  key: string
  label: string
  value: number | null
  previous: number | null
  unit: Unit
  note: string | null
}

export interface Point {
  date: string
  [k: string]: number | string | null
}

export interface StepStates {
  run_type: string
  total: number
  billed_usd: number
  states: Record<string, number>
}

export interface Payer {
  uid: string
  first_paid_at: string | null
  last_paid_at: string | null
  account_at: string | null
  payments: number
  paid: number
  gateway_total: number
  runs: number
}

export interface Overview {
  from: string
  to: string
  grain: Grain
  previous: { from: string; to: string }
  cards: KpiCard[]
  lifetime: {
    cash: number
    payers: number
    payments: number
    per_payer: number | null
    gateway_total: number
    accounts: number
    accounts_with_card: number
    accounts_deleted: number
    owed_in_batches: number
    owed_refused: number
    owed_pending: number
  }
  cash_series: Point[]
  people_series: Point[]
  run_series: Point[]
  by_step: StepStates[]
  states: string[]
  payers: Payer[]
}

export interface RunRow {
  id: string
  uid: string
  created_at: string | null
  updated_at: string | null
  run_type: string
  preset: string
  state: string
  stage: string | null
  progress: number | null
  quote: number
  error_code: string | null
  error_message: string | null
  error_detail: string | null
  cost_usd: number | null
}

export interface ErrorStep {
  run_type: string
  ended: number
  succeeded: number
  failed: number
  canceled: number
  expired: number
  running: number
  failure_rate: number | null
  cancel_rate: number | null
}

export interface OverdueRow extends RunRow {
  expected_seconds: number | null
  overdue_after_seconds: number
  run_start: string | null
  alerted_at: string | null
  overdue_now: boolean
  running_seconds: number | null
  reports: number
}

export interface ReportRow {
  conversion_id: string
  uid: string
  run_type: string
  preset: string
  state: string
  stage: string | null
  at: string | null
  note: string | null
}

export interface BillingRow {
  id: string
  uid: string
  created_at: string | null
  run_type: string
  preset: string
  state: string
  pi_status: string
  quote: number
  settle_error: string | null
  batch_id: string | null
}

export interface BatchRow {
  id: string
  uid: string
  state: string
  total: number
  runs: number
  opened_at: string | null
  closed_at: string | null
  close_reason: string | null
  settle_error: string | null
  updated_at: string | null
}

export interface Errors {
  from: string
  to: string
  grain: Grain
  totals: Omit<ErrorStep, 'run_type'> & { reports: number }
  by_step: ErrorStep[]
  series: Point[]
  codes: { code: string; stage: string; runs: number; last_at: string | null }[]
  failed: RunRow[]
  canceled: RunRow[]
  overdue: OverdueRow[]
  reports: ReportRow[]
  billing: BillingRow[]
  batches: BatchRow[]
}

export interface MarginRow {
  runs: number
  analyses: number
  without_cost: number
  revenue: number
  billed: number
  outstanding: number
  waived: number
  waived_runs: number
  cost: number
  margin: number
  margin_pct: number | null
  billed_margin_pct: number | null
  cost_per_item: number | null
  revenue_per_item: number | null
}

export interface Margin {
  from: string
  to: string
  grain: Grain
  total: MarginRow
  by_step: (MarginRow & { run_type: string })[]
  by_preset: (MarginRow & { run_type: string; preset: string })[]
  series: Point[]
  waived: { id: string; uid: string; created_at: string | null; run_type: string; preset: string; state: string; waived: number; reason: string | null; cost_usd: number | null }[]
  top_cost: (RunRow & { revenue: number; billed: number })[]
}

export interface SiteRow {
  value: string
  label: string
  visitors?: number
  pageviews?: number
  count?: number
  share: number | null
}

export interface SitePeriod {
  visitors: number
  pageviews: number
  events: number
  pages_per_visitor: number | null
}

export interface Site {
  from: string
  to: string
  notes: string[]
  current: SitePeriod
  previous: SitePeriod & { from: string; to: string }
  coverage: { site_from: string | null; site_to: string | null; utm: boolean }
  series: { date: string; visitors: number; pageviews: number; events: number }[]
  countries: SiteRow[]
  referrers: SiteRow[]
  pages: SiteRow[]
  devices: SiteRow[]
  utm_sources: SiteRow[]
  events: SiteRow[]
}
