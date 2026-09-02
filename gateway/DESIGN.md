# Gateway — production wrapper for the stereo3d Modal API

Single Go service on Cloud Run that sits between the Spatial Photo Studio app
and the Modal API. It owns client auth, Stripe billing, signed storage URLs,
job proxying/history, and support tooling. The Modal API itself is private
(Modal proxy-auth; only the gateway holds the token).

Replaces, with no backward compatibility (old system is retired):
- direct app → Modal calls (`/images_process`, `/video_process_v2`, …)
- the payments Cloud Run service (`spatial-video-studio-payments-app`)
- the storage Cloud Run service (`spatial-video-studio-storage-app`)

## Design goals

1. **Reliability** — jobs and money settle server-side. A user closing the app
   mid-job must never lose money or a result.
2. **Supportability** — one `conversion_id` traces a ticket end-to-end:
   Firestore record ↔ Stripe PaymentIntent ↔ Modal job ↔ Cloud Logging.
3. **Containment** — the Modal API's ~40-parameter research surface is not
   exposed; the gateway forwards a clamped, whitelisted subset.

## Billing models

Both share the invariants: price computed server-side from ffprobe'd media
(never from client-supplied numbers; rates in Firestore `config/pricing`),
one PaymentIntent per conversion carrying
`metadata: {conversion_id, user_id, env}`, and the user is never charged for
a failed or canceled run.

### Pro steps (web): pay-as-you-go on the saved card

Onboarding saves a card via a SetupIntent (`usage: off_session` — Stripe
runs the Google-style $0 verification + 3DS at save time); the gateway
caches the default payment method on the uid → customer mapping and heals
it from Stripe on every `GET /v1/billing` (so cards added or removed in the
billing portal are picked up).

- **Gate** — `POST /v1/projects/{id}/conversions` 402s
  (`no_payment_method` / `billing_overdue`) unless a card is on file and no
  automatic charge is outstanding. No checkout UI in any path.
- **Threshold hybrid** (`holdThresholdCents`, code constant in
  api/billing.go, currently $5):
  - **Quote ≥ threshold: off-session hold, capture on success.** A
    manual-capture PI is confirmed against the saved card at creation
    (idempotency key `hold_{env}_{id}`) — the bank re-approves the money
    BEFORE GPU spend. Declines 402 as `card_declined` and nothing starts; a
    3DS demand parks the conversion at `created` with the PI client_secret
    on the response (`billing.requires_action`) — the web client confirms
    with the saved card and the `amount_capturable_updated` webhook flips
    it to paid and submits. Success captures the hold; failure/cancel
    releases it.
  - **Quote < threshold: charge on success, no hold.** The conversion
    enters at `paid` and is submitted immediately; after outputs are
    published the quoted amount is charged off-session (idempotency key
    `charge_{env}_{id}`; retries `Confirm` the same PI). Cheap previews
    never leave pending lines on the user's statement.
- **Batched charging (2026-09-02).** Below-threshold steps no longer
  charge one by one — a session of previews is a burst of small
  same-merchant charges, which is exactly the velocity pattern issuer
  fraud rules block (it locked the developer's own card). On success the
  conversion becomes `pi_status=batched` and its price appends to the
  account's OPEN batch (`billing_batches_{env}`, pointer
  `customers.open_batch_id`; one Firestore transaction across customer,
  batch and conversion — api/batches.go, store/batches.go). The batch
  closes and becomes ONE off-session PI (idempotency key
  `batch_{env}_{batch_id}`, metadata `batch_id` + `conversion_ids`) when:
  its window elapses (`batch_window_hours`, default 4 — the reconciler
  closes due batches every minute), its total reaches the account's cap
  (checked on append; the closing step rides in the same charge), or the
  user calls `POST /v1/billing/pay-now`. Free items never enter a batch.
  - **Tiered cap** (`batch_tiers`, Firestore-tunable): the cap grows with
    `customers.lifetime_paid_cents` (money actually collected — batch
    charges, hold captures, legacy charges; seeded once from historical
    succeeded charges). Defaults: $50 → $150 after $200 collected → $400
    after $1,000 → $1,000 after $5,000. Exposure per account ≈ cap + one
    step, bounded by the window.
  - The hold threshold is lifted to the tier cap (`max($100, cap)`), so a
    trusted account batches the runs it is trusted for and holds only
    above its cap.
  - **Settlement**: a paid batch settles every conversion in it to
    `succeeded` (shared PI, own share) in the same transaction and credits
    lifetime spend. A card decision fails the batch AND flips its
    conversions to `charge_failed`, so the existing gates (requireBillable,
    downloadPaymentGate, `/v1/limits.unpaid_cents`) apply unchanged;
    `/v1/billing` lists the batch once (`unpaid[].batch_id` + `items`),
    `settle` re-arms it (conversions back to `batched`) and charges. The
    webhook routes PIs carrying `batch_id` to the batch (3DS fallback
    lands there). Transient errors leave it `charging` for the sweep.
  - `GET /v1/billing` exposes `pending` (the open batch) and `tier`
    (cap, window, lifetime spend, hold threshold, next tier). The mobile
    one-shot flow keeps per-conversion charging until `batch_one_shot`
    is switched on (mobile contract not yet updated).
- **Charge failure** (legacy per-conversion path, still used by the mobile
  one-shot flow) — transient errors stay `charge_pending` (reconciler
  retries); card decisions become `charge_failed`: the account is
  delinquent, new paid steps are blocked, and `POST /v1/billing/settle`
  retries against the current default card. A 3DS challenge
  (`authentication_required`) surfaces the PI's client_secret so the web
  client completes it on-session with the saved card.

### Legacy mobile flow: auth-then-capture

One manual-capture PaymentIntent per `POST /v1/conversions`:

- **Hold** — created at submission; app confirms via Apple Pay /
  PaymentSheet. Funds authorized, not captured.
- **Capture on success** — full quoted amount, after outputs are published.
- **Cancel on failure/cancel/expiry** — hold released.

Stripe holds are valid ~7 days; jobs run minutes-to-hours. A reconciler
sweep cancels holds for conversions stuck > 24 h as a safety net.

## Conversion state machine

```
                        (legacy hold mode enters here)
created ──payment confirmed (webhook)──▶ paid ──submitted to Modal──▶ processing
   │                                      ▲                             │
   │ (hold fails/expires)                 │ (pro steps enter at paid;   ├──▶ succeeded → capture hold / charge saved card
   ▼                                      │  billing verified up front) ├──▶ failed    → cancel PI (hold) / no charge
 expired                                  │                             └──▶ canceled  → cancel PI + DELETE Modal job
```

State only advances via the gateway (webhook, reconciler, or user cancel) —
the client is a pure observer. Transitions are idempotent: every mutation
checks current state first, and Stripe capture/cancel/charge calls are
themselves idempotent per conversion.

## HTTP surface

Client-facing (Firebase ID token in `Authorization: Bearer`):

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/customers` | Ensure Stripe customer for the Firebase user (on sign-in) |
| GET | `/v1/billing` | Pay-as-you-go status: saved card, delinquency, outstanding charges (ensures the profile + heals the default payment method) |
| POST | `/v1/billing/setup-intent` | SetupIntent for the web onboarding card capture |
| POST | `/v1/billing/settle` | Retry outstanding automatic charges on the current default card (returns 3DS client_secret when the bank requires action) |
| POST | `/v1/billing/portal` | Stripe customer-portal session (manage cards, receipts) |
| POST | `/v1/uploads` | Signed GCS PUT URL for source media |
| POST | `/v1/quotes` | Probe uploaded media, return price quote (also returned by create) |
| POST | `/v1/conversions` | Create conversion: probe → quote → PaymentIntent (manual capture) → Firestore record. Returns payment sheet params. Idempotent via `Idempotency-Key` header. |
| GET | `/v1/conversions` | List caller's conversions (job history UI + support) |
| GET | `/v1/conversions/{id}` | Status: state, progress, stage, quote, outputs |
| GET | `/v1/conversions/{id}/downloads` | Signed GCS GET URLs for outputs |
| DELETE | `/v1/conversions/{id}` | Cancel: cancels Modal job + releases hold |
| GET | `/health` | Liveness |

Machine-facing:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/webhooks/stripe` | Stripe signature | hold mode: `payment_intent.amount_capturable_updated` → submit to Modal, `payment_intent.canceled` → mark expired. auto mode: `payment_intent.succeeded` → fold the charge in (3DS fallback lands here), `payment_intent.payment_failed` → mark the account delinquent |
| POST | `/internal/reconcile` | Cloud Scheduler OIDC | Poll Modal for active conversions, settle terminal states, expire stale holds |

Request params accepted on `/v1/conversions` (everything else is server-set):
`kind` (video|image), `source_path` (from `/v1/uploads`), `preset`
(draft|1080p|qhd|3k|4k), `formats` (whitelist incl. mvhevc), `displacement`
(clamped (0, 0.03]), `target_fps`, `from_sec`/`to_sec`, `app_version`,
`platform`. The gateway sets `notify`, never forwards reuse/fan-out knobs,
and clamps everything server-side. (`adaptive` is set BY the gateway for pro
steps — see below — never taken from the client.)

## Pro pipeline: per-scene model, adaptive by default

The web workspace edits a video as a list of scenes (source-frame cuts,
versioned on the project). Two decisions shape the step params:

- **Adaptive is the product default, not a knob.** Every pro step
  (depth_preview | stereo_preview | production) is submitted with
  `adaptive: true`: Modal's per-shot profiler picks displacement / shot type
  / placement per scene, and the user CORRECTS it rather than configuring
  stereo from scratch. The correction surface is `scene_overrides`
  (per-scene `displacement` / `shot_type` / `placement`, keyed by the
  scene's first source frame) plus a global `depth_scale`; the legacy
  single global `displacement` is rejected on pro steps. Override firsts are
  validated against the project's CURRENT cuts and the conversion records
  `scenes_version`, so a cut edit invalidates nothing silently.
- **The profiler's output is fed back.** On every succeeded pro video
  conversion the gateway folds the job's `depth_script` (entries carry
  `first_src`/`last_src` in source-frame space; extra research keys are
  ignored, entries without src-frame bounds are skipped) into
  `project.scene_profile`. That is what the Stereo page seeds its per-scene
  editors from — the user always edits relative to what the pipeline
  actually measured, and support can diff "profiled" vs "overridden".

The Depth page owns `depth_res` (multiple of 14, [140, 2520]) — the depth
map's inference resolution, THE quality/cost knob. depth_preview accepts it
so the user locks the FINAL resolution while previewing (the job's
`depth_vis` output is the browser-playable depth video); production then
reuses the cached depth artifact when depth_res + fps match. Pricing scales
the depth share of a step by `clamp((depth_res/depth_res_base)², 0.5, 4)` —
quadratic because depth inference cost is ~res². Stereo previews choose
splatted (`inpaint: none`, default) or inpainted (`propainter`, priced by
`inpaint_multiplier`); production defaults to `propainter`, already priced
into its per-preset rates.

## Data model (Firestore)

`customers/{uid}`: `stripe_customer_id`, `email`, `created_at`.

`conversions/{id}` (id = 12-hex, generated by gateway, used everywhere):

```
uid, env, state, kind, created_at, updated_at
client:  {app_version, platform}
source:  {gcs_key, bytes, duration_s, frames, fps, width, height}   # from ffprobe
params:  {preset, formats, displacement, target_fps, from_frame, to_frame,   # as forwarded
          inpaint, warp, depth_res, depth_scale, scene_cuts, scene_overrides, skip_reuse}
quote:   {amount_cents, currency, rate_version, breakdown}
stripe:  {customer_id, payment_intent_id, pi_status, captured_cents, capture_at, canceled_at}
modal:   {job_id, submitted_at, last_polled_at, progress, stage, eta_seconds,
          cost_usd, timings_summary}
outputs: {name → gcs_key}
error:   {code, user_message, internal_message}     # internal never sent to client
```

Support flow for a ticket: user quotes `conversion_id` → Firestore doc has
params/timings/error → `stripe.payment_intent_id` links the charge (and the
PI's metadata links back) → `modal.job_id` finds pipeline logs → Cloud
Logging is filterable by `conversion_id` (structured field on every log line).
Slack gets a notification on every failure (conversion_id, uid, error) before
the user writes in.

`config/pricing` (per-env doc, hot-reloaded with a TTL cache; code defaults
if missing): `rate_version`, `currency`, per-preset `cents_per_minute`,
`image_cents` (per paid still past the free daily allowance — always batched,
never charged alone; a sub-minimum batch rolls over), `minimum_cents`,
`discount_threshold_cents`, `discount_pct`,
`max_duration_s`, `max_source_bytes`, `max_active_per_user`.

## Storage

Bucket `spatial-video-studio-app`, env prefix `stereo3d/{test|prod}/` (same
convention as the Modal app; prod isolated).

- Uploads: `stereo3d/{env}/users/{uid}/{conversion_id}/source.{ext}` via
  V4 signed PUT URL (15 min, content-length capped).
- Modal outputs land under `stereo3d/{env}/outputs/{job_id}/`; the gateway
  translates to V4 signed GET URLs (24 h) on demand. Clients never receive
  raw `storage.googleapis.com` public URLs.
- Signing uses the Cloud Run service account via IAM SignBlob (needs
  `roles/iam.serviceAccountTokenCreator` on itself).

## Modal client

Base URL `https://{workspace}--stereo3d-api-{env}.modal.run` from config.
Endpoints used: `POST /v1/videos`, `POST /v1/images`, `GET/DELETE
/v1/jobs/{job_id}`. Every request carries `Modal-Key` / `Modal-Secret`
(proxy-auth token from Secret Manager) — the corresponding change on the
Modal side is `requires_proxy_auth=True` on the web endpoint. Timeouts 30 s,
one retry on 5xx/network for idempotent calls; submit is guarded by the state
machine rather than blind retries (a conversion in `paid` with no
`modal.job_id` is re-submitted by the reconciler).

## Reconciler

Cloud Scheduler → `POST /internal/reconcile` every 60 s (OIDC service
account auth):

1. Query conversions in `processing` → `GET /v1/jobs/{id}` → update
   progress/stage; on `completed`: copy outputs map + cost, capture PI, state
   `succeeded`; on `failed`: cancel PI, state `failed`, Slack notify.
2. Query `paid` with no Modal job (webhook lost / submit crashed) → submit.
3. Query `created` older than 24 h → cancel PI if present, state `expired`.

`GET /v1/conversions/{id}` also does a read-through poll of Modal when the
record is active and `last_polled_at` > 10 s old, so interactive polling
stays fresh without waiting for the sweep.

## Abuse containment

- Firebase ID token verified on every request (anonymous accounts allowed,
  same as the app's current sign-in flow).
- Params whitelisted + clamped; unknown fields dropped.
- `max_active_per_user` concurrent conversions; per-source duration/bytes
  caps from pricing config (0-cost media rejected).
- Modal errors logged in full, returned to clients as generic
  `upstream_error` with the conversion_id for support.

## Layout

```
gateway/
├── cmd/gateway/main.go      # wiring, routes, middleware
├── internal/
│   ├── api/                 # handlers (conversions, uploads, webhooks, reconcile)
│   ├── auth/                # Firebase ID token verification
│   ├── config/              # env config
│   ├── httpx/               # request-id middleware, error/success JSON envelope
│   ├── modalapi/            # Modal API client (proxy-auth)
│   ├── pricing/             # quote calculation + Firestore config cache
│   ├── probe/               # ffprobe wrapper (signed-URL or GCS read)
│   ├── store/               # Firestore models + queries + state transitions
│   ├── stripex/             # Stripe client (customers, PI lifecycle, webhook verify)
│   └── notify/              # Slack failure notifications
├── Dockerfile               # distroless-ish + ffprobe
├── deploy.sh                # Cloud Run deploy (test|prod) + scheduler job
└── README.md
```

Config via env vars: `APP_ENV` (test|prod), `GCP_PROJECT_ID`, `BUCKET_NAME`,
`MODAL_BASE_URL`, `MODAL_TOKEN_ID/SECRET` (Secret Manager),
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`,
`SLACK_WEBHOOK_URL` (optional), `FIREBASE_PROJECT_ID`.
