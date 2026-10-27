-- Raw landing tables (one per source) and bookkeeping. Idempotent; runs on every start.

create table if not exists ingest_run (
  id bigserial primary key,
  source text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',   -- running | ok | error
  detail text
);
create index if not exists ingest_run_source_idx on ingest_run (source, started_at desc);

-- A pass the dashboard's Refresh button asked for; the ingest loop takes it within 30 seconds.
-- `sources` names the sources to run (comma-separated, as --only takes them); null means all.
create table if not exists ingest_request (
  id bigserial primary key,
  requested_at timestamptz not null default now(),
  taken_at timestamptz,
  sources text
);

-- Where an incremental source stopped (Firestore: the last updated_at read and the last full scan;
-- Vercel: the last day loaded).
create table if not exists ingest_cursor (
  source text primary key,
  cursor jsonb not null,
  updated_at timestamptz not null default now()
);

-- The gateway's Firestore records (gateway/internal/store/models.go), one row per document, the
-- document whole as JSON with its timestamps as ISO strings. Typed columns live in the views
-- (sql/views.sql), so a field the gateway adds is there without a migration. Removed before storing:
-- stripe.client_secret (a live 3DS secret) and every email address (customers.email,
-- support.reports[].email); nothing on the dashboard needs them.
create table if not exists fs_conversion (
  id text primary key,
  doc jsonb not null,
  updated_at timestamptz,
  loaded_at timestamptz not null default now()
);
create table if not exists fs_project (
  id text primary key,
  doc jsonb not null,
  updated_at timestamptz,
  loaded_at timestamptz not null default now()
);
create table if not exists fs_customer (
  id text primary key,                       -- the Firebase uid
  doc jsonb not null,
  updated_at timestamptz,                    -- customers carry no updated_at; null, re-read on every pass
  loaded_at timestamptz not null default now()
);
create table if not exists fs_batch (
  id text primary key,
  doc jsonb not null,
  updated_at timestamptz,
  loaded_at timestamptz not null default now()
);

-- The website's Vercel Web Analytics, one row per day, dimension and value. `site_daily` holds the
-- visits: dimension total (value ''), path, country, referrer (hostname, '' for none), device,
-- utm_source; a value named 'Others' is Vercel's fold past its 100 groups. `site_event_daily` holds
-- the web app's custom events (track()) by name. Vercel answers only the last 366 days, so these
-- tables are the history past that.
create table if not exists site_daily (
  date date not null,
  dimension text not null,
  value text not null,
  pageviews integer not null default 0,
  visitors integer not null default 0,
  loaded_at timestamptz not null default now(),
  primary key (date, dimension, value)
);
create table if not exists site_event_daily (
  date date not null,
  event text not null,                       -- always '*' for now: events are read by name below
  dimension text not null,                   -- 'name'
  value text not null,                       -- the event name
  count integer not null default 0,
  visitors integer not null default 0,
  loaded_at timestamptz not null default now(),
  primary key (date, event, dimension, value)
);
