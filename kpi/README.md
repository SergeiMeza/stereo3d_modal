# Stereo3D Studio KPIs

A local dashboard for the Stereo3D Studio web app (WEB-KPI-01), at **http://localhost:8003**.
It copies the Spatial Video Studio KPI stack (`spatial-video-studio/kpi`): Postgres 16, a Python
ingest loop, a FastAPI service that reads SQL views and serves the built React/Vite dashboard.
Records only for now; the app's event pipeline is WEB-KPI-02, mails and alerts WEB-KPI-03.

## Run it

```sh
cd kpi
make up      # writes .env (make env), checks the SSD (make data-dir), builds and starts everything
make open    # http://localhost:8003
make logs    # ingest + api logs
make down    # stops the stack (the data stays on the SSD)
```

| Service | What it does | Port |
|---|---|---|
| `db` | Postgres 16, data on the SSD at `/Volumes/Dev/Data/s3d-kpi/postgres` | `127.0.0.1:5436` |
| `ingest` | one pass at start, then every `INGEST_INTERVAL_HOURS` (1), or when Refresh is pressed | – |
| `api` | `/api/*` (docs at `/api/docs`) and the dashboard | `127.0.0.1:8003` |
| `backup` | a `pg_dump` about once a day to `/Volumes/Dev/Data/s3d-kpi/backups`, 14 kept | – |

Compose project `s3d-kpi`, image `s3d-kpi:latest`. The database is a bind mount on the external
SSD with `create_host_path: false`, never a Docker volume: with the SSD unplugged the database
refuses to start instead of initialising an empty one. Other targets: `make backfill` (one full
pass now), `make psql`, `make backup` (a dump now), `make restore` (the newest dump, or
`DUMP=path`).

`make env` writes `.env` (git-ignored) from `.env.example` without printing anything secret:

- `FIRESTORE_SA_FILE=~/dev/svs-kpi-firestore.json`: the Spatial Video Studio KPI's read-only
  service account (roles/datastore.viewer) on the same GCP project, `spatial-video-studio`. It is
  mounted read-only into the ingest container.
- `VERCEL_TOKEN`: copied from `~/dev/s3d-kpi-vercel.env` (`VERCEL_TOKEN=...`) when that file exists.
  **The Spatial Video Studio KPI's token does not work here**: it is scoped to the
  spatial-video-studio project and answers 404 for stereo3d-studio. Create a read token in Vercel
  (team spatial-ai-labs) that can see the stereo3d-studio project, put it in
  `~/dev/s3d-kpi-vercel.env` and run `make up` (it fills an empty `VERCEL_TOKEN=` in `.env`). Until then the Website page says why it is empty and the source shows
  "skipped".

## Sources (read-only)

| Source | From | How |
|---|---|---|
| `conversions` | Firestore `conversions_prod` | incremental by `updated_at` (re-reads 10 min back); a full scan on the first pass and every 24 h, which also drops deleted documents |
| `projects` | Firestore `projects_prod` | same |
| `customers` | Firestore `customers_prod` | full scan every pass (the documents carry no `updated_at`) |
| `billing_batches` | Firestore `billing_batches_prod` | incremental like conversions |
| `site_analytics` | Vercel Web Analytics, project `stereo3d-studio` (`web/.vercel/project.json`) | the last 366 days on the first pass, then the last 3 days again each pass; visits by day × path / country / referrer / device / UTM source, and the custom `track()` events by name |

Each Firestore document lands whole as JSON (`fs_conversion`, `fs_project`, `fs_customer`,
`fs_batch`); the typed columns live in the views, so a field the gateway adds needs no migration.
Removed before storing: `stripe.client_secret` and every email address. Nothing is ever written to
Firestore. The schema is `gateway/internal/store/models.go`.

## Metric definitions

All days are **UTC** calendar days; all money is USD (the quote currency of every record so far;
`v_currency_check` lists anything else and the Sources popover counts it). The definitions live in
`backend/sql/views.sql`, each view with a comment:

- **Run** (`v_conversion`): one conversion. `run_type` is the pro step (`depth_preview`,
  `stereo_preview`, `production`), or `image` (stills) / `video` (the mobile app's whole-clip runs)
  for plain conversions. Runs are dated by `created_at`.
- **Cash collected** (`v_cash`): one row per payment that reached Stripe, on the day it was
  collected: a paid billing batch's `charged_cents` at `charged_at`; a run charged on its own
  (`stripe.captured_cents` at `captured_at`, `pi_status = succeeded`, no batch); a captured card
  hold (the mobile flow). A batched run is never counted on its own (its money is its batch's).
  Waived runs collect nothing. Refunds made by hand in Stripe are not in Firestore and are not
  subtracted.
- **Paying customers** (period): distinct uids with a payment in the range. **New paying
  customers**: uids whose first payment ever (`v_payer.first_paid_at`) falls in the range.
- **New billing accounts**: `customers_prod` records created in the range (made when someone first
  enters the billing flow, card or not).
- **Average per payer**: cash in the range ÷ paying customers in the range. **Lifetime value per
  payer**: all cash ÷ everyone who ever paid.
- **Owed**: the quote of succeeded runs not collected yet: in an open batch (`batched`), awaiting a
  charge (`charge_pending`, `capture_pending`), or **refused** by the card (`charge_failed`,
  `capture_failed`).
- **Failure rate**: failed ÷ (succeeded + failed) among runs created in the range; cancellations are
  left out (the user chose to stop). **Expired**: hold-mode runs never paid.
- **Overdue** (`v_overdue`): the gateway's own rule (`gateway/internal/api/overdue.go`): a paid or
  processing run past its estimate plus the estimate again as slack (15 min to 1 h); 45 min without
  an estimate; the clock starts at GPU submission. Listed when the gateway flagged it
  (`support.overdue_alerted_at`) or it is overdue at the last ingest.
- **User reports** (`v_report`): `support.reports[]`, one row each (the note, not the email).
- **Margin** (`v_margin_item`): per run, revenue = cash attributed to the run (`collected_cents`:
  `captured_cents` once `pi_status = succeeded`, which for a batched run is its share of the paid
  batch), billed = the quote of a succeeded run, cost = `modal.cost_usd`; plus every project's free
  analyze job (`analyze.cost_usd`, no revenue). Gross margin = revenue − GPU cost, margin % = that ÷
  revenue. Both sides are dated by the run's creation day. Waived runs (`waived.amount_cents`,
  `waived.reason`) count as cost with zero revenue, the waived amount shown beside. Runs without a
  recorded cost count as zero, so the cost is a floor; Cloud Run, storage, egress and Stripe fees are
  not in it.
- **Website**: Vercel's visitors are counted once per day and page, so sums over days or rows count a
  returning visitor again.

## Pages

- **Overview**: cash collected, paying / new paying customers, new billing accounts, average per
  payer, runs (cards against the previous period); all-time cash, payers, lifetime value per payer,
  owed and refused; cash per day/week/month by how it was collected; new customers; runs by step
  and state; every payer with what they paid beside the gateway's own `lifetime_paid_cents`.
- **Errors**: failure rate per step and per bucket, failed runs by error code and stage and each
  failed run with its error, overdue runs and user reports, canceled/expired runs, billing problems
  (refused charges, failed or stuck batches).
- **Margin**: revenue against GPU cost in total, per step, per step and preset, over time; waived
  runs; the costliest runs.
- **Website**: visitors, pageviews, custom events, day by day, countries, referrers, top pages,
  devices, events by name, UTM sources (if the plan has them).

## Develop

`cd web && npm ci && npm run dev` serves the dashboard on :5176 against the running api on :8003.
The backend reads `DATABASE_URL` (default `postgresql://kpi:kpi@localhost:5436/kpi`), so
`python -m kpi.ingest --once` and `uvicorn kpi.api:app` also run outside Docker from `backend/`.
