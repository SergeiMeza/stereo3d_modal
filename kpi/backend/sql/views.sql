-- Transform layer: everything the API reads comes from these views, and every metric's definition
-- is here. All times are UTC (db.connect sets the session time zone); a "day" is a UTC calendar day.
-- Money is in the quote's currency, which is USD for every record so far (v_currency_check lists any
-- other); cents in the tables, dollars only where a view says _usd.
--
-- Views are dropped and recreated on every start, so a column can change without a migration.

drop view if exists v_currency_check cascade;
drop view if exists v_report cascade;
drop view if exists v_overdue cascade;
drop view if exists v_margin_item cascade;
drop view if exists v_payer cascade;
drop view if exists v_cash cascade;
drop view if exists v_conversion cascade;
drop view if exists v_batch cascade;
drop view if exists v_customer cascade;
drop view if exists v_project cascade;

-- One row per conversion (a "run"): the gateway's conversions_prod record with typed columns.
--   run_type   the pro pipeline step (depth_preview | stereo_preview | production), else the kind of
--              a plain conversion ('image' for stills, 'video' for the mobile app's whole-clip runs)
--   collected_cents  money that reached Stripe for this run: stripe.captured_cents once pi_status is
--              'succeeded'. Covers hold captures, single auto charges, and batched runs (whose share
--              the gateway writes as captured_cents = quote when their batch is paid). This is the
--              per-run attribution used by Margin; cash by day uses v_cash so a batch counts once.
--   billed_cents     the quote of a succeeded run: what the user owes for it, collected or not
--              (failed and canceled runs are never charged).
--   outstanding_cents billed but not collected: in an open or charging batch (pi_status batched),
--              awaiting a charge (charge_pending, capture_pending) or refused by the card
--              (charge_failed, capture_failed).
--   waived     the owner ran it free of charge after the fact (waived.amount_cents, waived.reason;
--              e.g. the 2026-10-27 depth-queue incident). Its quote is 0, so it bills nothing; Margin
--              shows its GPU cost against zero revenue and the waived amount beside it.
create view v_conversion as
select b.*,
       case when b.pi_status = 'succeeded' then b.captured_cents else 0 end as collected_cents,
       case when b.state = 'succeeded' then b.quote_cents else 0 end as billed_cents,
       case when b.state = 'succeeded' and b.pi_status <> 'succeeded' then b.quote_cents else 0 end as outstanding_cents,
       b.state in ('succeeded', 'failed', 'canceled', 'expired') as terminal,
       -- the gateway's overdue rule (gateway/internal/api/overdue.go): a paid or processing run past
       -- its estimate plus the estimate again as slack (kept between 15 min and 1 h); 45 min without
       -- an estimate. The clock starts at GPU submission, else at creation.
       case when coalesce(b.expected_seconds, 0) <= 0 then 2700
            else b.expected_seconds + least(greatest(b.expected_seconds, 900), 3600) end as overdue_after_seconds,
       coalesce(b.submitted_at, b.created_at) as run_start
from (
  select c.id,
         c.doc->>'uid' as uid,
         c.doc->>'kind' as kind,
         nullif(c.doc->>'step', '') as step,
         coalesce(nullif(c.doc->>'step', ''), case when c.doc->>'kind' = 'image' then 'image' else 'video' end) as run_type,
         coalesce(nullif(c.doc#>>'{params,preset}', ''), '(none)') as preset,
         c.doc->>'state' as state,
         nullif(c.doc->>'project_id', '') as project_id,
         nullif(c.doc#>>'{client,platform}', '') as platform,
         (c.doc->>'created_at')::timestamptz as created_at,
         ((c.doc->>'created_at')::timestamptz)::date as day,
         (c.doc->>'updated_at')::timestamptz as updated_at,
         coalesce((c.doc#>>'{quote,amount_cents}')::bigint, 0) as quote_cents,
         lower(coalesce(nullif(c.doc#>>'{quote,currency}', ''), 'usd')) as currency,
         coalesce(c.doc#>>'{stripe,mode}', '') as billing_mode,
         coalesce(c.doc#>>'{stripe,pi_status}', '') as pi_status,
         nullif(c.doc#>>'{stripe,batch_id}', '') as batch_id,
         coalesce((c.doc#>>'{stripe,captured_cents}')::bigint, 0) as captured_cents,
         (c.doc#>>'{stripe,captured_at}')::timestamptz as captured_at,
         nullif(c.doc#>>'{stripe,settle_error}', '') as settle_error,
         nullif(c.doc#>>'{modal,job_id}', '') as modal_job_id,
         (c.doc#>>'{modal,submitted_at}')::timestamptz as submitted_at,
         (c.doc#>>'{modal,progress}')::float8 as progress,
         nullif(c.doc#>>'{modal,stage}', '') as stage,
         coalesce((c.doc#>>'{modal,cost_usd}')::numeric, 0) as cost_usd,
         (c.doc#>>'{modal,cost_usd}') is not null as has_cost,
         nullif(c.doc#>>'{error,code}', '') as error_code,
         nullif(c.doc#>>'{error,user_message}', '') as error_message,
         nullif(c.doc#>>'{error,internal_message}', '') as error_detail,
         nullif((c.doc#>>'{support,expected_seconds}')::bigint, 0) as expected_seconds,
         (c.doc#>>'{support,overdue_alerted_at}')::timestamptz as overdue_alerted_at,
         case when jsonb_typeof(c.doc#>'{support,reports}') = 'array' then jsonb_array_length(c.doc#>'{support,reports}') else 0 end as report_count,
         c.doc ? 'waived' as waived,
         coalesce((c.doc#>>'{waived,amount_cents}')::bigint, 0) as waived_cents,
         c.doc#>>'{waived,reason}' as waived_reason
  from fs_conversion c
) b;

-- One row per billing batch (billing_batches_prod): the user's running tab of succeeded auto-billed
-- runs, charged as one payment when its window ends, it reaches the tier cap, or the user pays now.
-- state: open (accumulating) | charging (closed, charge committed) | paid | failed (card refused;
-- the account is delinquent until settled). charged_cents/charged_at are set when paid.
create view v_batch as
select b.id,
       b.doc->>'uid' as uid,
       b.doc->>'state' as state,
       lower(coalesce(nullif(b.doc->>'currency', ''), 'usd')) as currency,
       coalesce((b.doc->>'total_cents')::bigint, 0) as total_cents,
       coalesce((b.doc->>'cap_cents')::bigint, 0) as cap_cents,
       coalesce((b.doc->>'charged_cents')::bigint, 0) as charged_cents,
       (b.doc->>'charged_at')::timestamptz as charged_at,
       (b.doc->>'opened_at')::timestamptz as opened_at,
       (b.doc->>'due_at')::timestamptz as due_at,
       (b.doc->>'closed_at')::timestamptz as closed_at,
       nullif(b.doc->>'close_reason', '') as close_reason,
       case when jsonb_typeof(b.doc->'items') = 'array' then jsonb_array_length(b.doc->'items') else 0 end as item_count,
       nullif(b.doc->>'settle_error', '') as settle_error,
       (b.doc->>'created_at')::timestamptz as created_at,
       (b.doc->>'updated_at')::timestamptz as updated_at
from fs_batch b;

-- One row per web account with a billing record (customers_prod; created on first sign-in to the
-- billing flow). lifetime_paid_cents is the gateway's own running total of money collected from the
-- user (it picks the batch tier); v_payer is the dashboard's count from the payment records.
create view v_customer as
select c.id as uid,
       nullif(c.doc->>'stripe_customer_id', '') as stripe_customer_id,
       (c.doc->>'created_at')::timestamptz as created_at,
       ((c.doc->>'created_at')::timestamptz)::date as day,
       coalesce((c.doc->>'lifetime_paid_cents')::bigint, 0) as lifetime_paid_cents,
       coalesce(nullif(c.doc->>'default_payment_method', ''), '') <> '' as has_card,
       coalesce((c.doc->>'photo_credits')::bigint, 0) as photo_credits,
       nullif(c.doc->>'open_batch_id', '') as open_batch_id,
       coalesce((c.doc->>'account_deleted')::boolean, false) as account_deleted,
       (c.doc->>'deleted_at')::timestamptz as deleted_at
from fs_customer c;

-- One row per pro project (projects_prod). The analyze job (scene detection, proxy, thumbnails) is
-- free to the user and runs on the GPU, so its cost counts in Margin with zero revenue.
create view v_project as
select p.id,
       p.doc->>'uid' as uid,
       (p.doc->>'created_at')::timestamptz as created_at,
       ((p.doc->>'created_at')::timestamptz)::date as day,
       nullif(p.doc#>>'{analyze,job_id}', '') as analyze_job_id,
       nullif(p.doc#>>'{analyze,state}', '') as analyze_state,
       coalesce((p.doc#>>'{analyze,cost_usd}')::numeric, 0) as analyze_cost_usd,
       (p.doc#>>'{analyze,cost_usd}') is not null as has_cost,
       coalesce((p.doc#>>'{analyze,credit_cents}')::bigint, 0) as analyze_credit_cents,
       (p.doc#>>'{probe,duration_s}')::float8 as duration_s,
       coalesce((p.doc->>'archived')::boolean, false) as archived
from fs_project p;

-- Cash collected: one row per payment that reached Stripe, on the day it was collected (UTC).
--   batch         a paid batch's charged_cents at charged_at (one Stripe charge for several runs)
--   charge        a run charged on its own (auto mode before batching, or the web 3DS fallback)
--   hold_capture  a run whose card hold was captured on success (the mobile PaymentSheet flow)
-- A batched run is not listed on its own: its money is its batch's. Waived runs collect nothing.
-- Refunds made by hand in Stripe are not in Firestore, so they are not subtracted here.
create view v_cash as
select 'batch'::text as source, b.id as ref, b.uid, b.charged_at as at, (b.charged_at)::date as day,
       b.charged_cents as cents, b.item_count as runs
from v_batch b
where b.state = 'paid' and b.charged_cents > 0
union all
select case when c.billing_mode = '' then 'hold_capture' else 'charge' end, c.id, c.uid,
       coalesce(c.captured_at, c.updated_at), (coalesce(c.captured_at, c.updated_at))::date,
       c.collected_cents, 1
from v_conversion c
where c.batch_id is null and c.collected_cents > 0 and not c.waived;

-- Paying customers: every uid with at least one payment in v_cash, with the first one (a "new paying
-- customer" in a period is one whose first payment falls in it) and what they paid in all.
create view v_payer as
select uid, min(at) as first_paid_at, (min(at))::date as first_paid_day, max(at) as last_paid_at,
       count(*) as payments, sum(cents) as paid_cents
from v_cash
group by uid;

-- Margin items: everything that spent GPU money, with what it brought in.
--   run      a conversion: revenue = collected_cents (cash attributed to the run), billed = its quote
--            if it succeeded, cost = modal.cost_usd (Modal's GPU cost the gateway records at the end)
--   analyze  a project's free analyze job: cost = analyze.cost_usd, no revenue
-- Gross margin = revenue - GPU cost. Costs not in Firestore (Cloud Run, storage, egress, Stripe's
-- fees) are not in it. Items are dated by the day they were created (UTC), so a run and its cost
-- land on the same day even when its batch is charged later.
create view v_margin_item as
select c.id, 'run'::text as source, c.uid, c.run_type, c.preset, c.state, c.day, c.created_at,
       c.collected_cents / 100.0 as revenue_usd, c.billed_cents / 100.0 as billed_usd,
       c.outstanding_cents / 100.0 as outstanding_usd, c.waived_cents / 100.0 as waived_usd,
       c.waived, c.cost_usd, c.has_cost
from v_conversion c
union all
select p.id, 'analyze', p.uid, 'analyze', '(free)', coalesce(p.analyze_state, ''), p.day, p.created_at,
       0, 0, 0, 0, false, p.analyze_cost_usd, p.has_cost
from v_project p
where p.analyze_job_id is not null;

-- Runs that were or are late: flagged by the gateway's overdue alert (support.overdue_alerted_at),
-- or paid/processing right now past the overdue rule (overdue_after_seconds from run_start).
create view v_overdue as
select c.*,
       now() - c.run_start as running_for,
       (c.state in ('paid', 'processing') and now() > c.run_start + make_interval(secs => c.overdue_after_seconds)) as overdue_now
from v_conversion c
where c.overdue_alerted_at is not null
   or (c.state in ('paid', 'processing') and now() > c.run_start + make_interval(secs => c.overdue_after_seconds));

-- User reports ("this run is stuck", support.reports[] on a conversion), one row per report. The
-- reporter's email is not stored (see schema.sql); the note is.
create view v_report as
select c.id as conversion_id, c.uid, c.run_type, c.preset, c.state, c.stage,
       (r->>'at')::timestamptz as at, nullif(r->>'note', '') as note
from fs_conversion f
join v_conversion c on c.id = f.id
cross join lateral jsonb_array_elements(case when jsonb_typeof(f.doc#>'{support,reports}') = 'array'
                                             then f.doc#>'{support,reports}' else '[]'::jsonb end) r;

-- Anything not in USD, which every money total above would add as if it were.
create view v_currency_check as
select 'conversion' as kind, id, currency from v_conversion where currency <> 'usd' and quote_cents > 0
union all
select 'batch', id, currency from v_batch where currency <> 'usd' and total_cents > 0;
