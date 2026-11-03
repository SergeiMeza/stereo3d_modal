# stereo3d gateway

Production wrapper for the stereo3d Modal API — Go on Cloud Run. Owns client
auth (Firebase), billing (Stripe pay-as-you-go for the web pro flow,
auth-then-capture for the legacy mobile flow), signed storage URLs, job
history, and support tooling. Architecture and rationale: [DESIGN.md](DESIGN.md).

## Billing (web pro flow): pay-as-you-go

```
GET  /v1/billing                      status: saved card, delinquency, unpaid charges
                                      (ensures the Stripe customer; heals the default card)
POST /v1/billing/setup-intent         → SetupIntent client_secret for onboarding card capture
POST /v1/billing/settle               retry outstanding automatic charges on the current card
POST /v1/billing/portal               Stripe customer portal (manage cards, receipts)
GET  /v1/billing/history?limit=&cursor=
                                      purchase history (S3D-57): one entry per card
                                      charge, newest first — {id, type charge|refund,
                                      created_at, amount_cents (refunds negative,
                                      refund_of names the charge), currency, card_brand,
                                      card_last4, status paid|refunded|
                                      partially_refunded|failed|pending, receipt_url,
                                      items: [{project_id, project_name, step
                                      preview|production|photo, method, quality,
                                      amount_cents, conversion_id}]}; a grouped charge
                                      lists every run it covered; an open, uncharged
                                      batch is not listed; next_cursor pages on
```

Onboarding saves a card once (SetupIntent, off-session usage — Stripe's $0
card verification runs at save time). Paid steps 402 (`no_payment_method` /
`billing_overdue`) unless a card is on file and nothing is owed. Threshold
hybrid (`holdThresholdCents` constant, $100): quotes at/above it place an
off-session HOLD on the saved card before the job runs (declines 402 as
`card_declined`; 3DS parks the conversion at `created` until the web client
confirms) and capture it on success; smaller quotes skip the hold and charge
the card only when the conversion SUCCEEDS. The user is never charged for a
failed run in either path. A failed post-success charge marks the account
delinquent — results stay available (downloads never lock for payment), new paid steps are blocked until
`/v1/billing/settle` (3DS challenges return the PI client_secret for the web
confirmCardPayment fallback). The default card is cached on
`customers_{env}` (Firestore) and refreshed from Stripe on every
`GET /v1/billing`.

## Legacy client flow (mobile, auth-then-capture)

```
POST /v1/customers                    once per sign-in (ensures Stripe customer)
POST /v1/uploads                      → signed PUT URL; app uploads source media
POST /v1/conversions                  → quote + PaymentSheet params (hold, not charge)
  (app confirms payment via PaymentSheet / Apple Pay)
GET  /v1/conversions/{id}             poll state/progress (webhook+reconciler drive it server-side)
GET  /v1/conversions/{id}/downloads   → signed GET URLs when state=succeeded
DELETE /v1/conversions/{id}           cancel (releases hold)
```

The user is charged only when a conversion succeeds; failures and cancels
release the hold automatically.

## Pro step pipeline (web client)

1 video = 1 project (web/DESIGN.md). All frame values are integer
source-frame indices, half-open ranges — never seconds.

```
POST  /v1/projects                     create from an upload; free analyze job starts
GET   /v1/projects[/{id}]              list / project detail (+conversion history);
                                       ?archived=1 lists archived projects instead
PATCH /v1/projects/{id}                project management {name?, pinned?, archived?};
                                       archived:true cancels active runs, false restores
PATCH /v1/projects/{id}/scenes         replace scene cuts {cuts, expect_version}
POST  /v1/projects/{id}/profile        FREE standalone shot profiling (adaptive
                                       profiler over the analyze proxy + current
                                       cuts) → folds into scene_profile; live
                                       state on project.profile
POST  /v1/projects/{id}/quotes         price a step {step, preset, ...} — no commitment
POST  /v1/projects/{id}/conversions    paid step conversion (depth_preview |
                                       stereo_preview | production); billing gate
                                       up front (402), starts immediately, saved
                                       card charged on success
DELETE /v1/projects/{id}               archive + cancel active conversions
```

The analyze step is free outright. (`analyze_credit_cents`, default 0 since
2026-08-31, can re-enable the legacy credit-back: a discount on the
project's first paid conversion, restored if that conversion ends without a
capture.) Production quotes check Modal's
content-addressed reuse cache and discount by `stage_shares` for cached
stages; `from_scratch: true` bypasses reuse (and its discount) entirely.

### Step parameters

Every pro step runs Modal's adaptive per-shot profiler (the gateway always
sends `adaptive: true`); the knobs below shape it. Global `displacement` is
rejected on pro steps and a top-level `placement` is not a pro-step field
(use `scene_overrides[].placement`) — both remain `POST /v1/conversions`
(mobile one-shot) fields: `displacement` (0, 0.03], `placement: [far, near]`
with −1.5 ≤ far < near ≤ 1.5 (default `[-1.0, 0.5]`), forwarded to Modal
for video and image alike so cloud output can match the app's on-device
kernel.

| param | steps | rails |
|---|---|---|
| `depth_res` | all | multiple of 14 in [140, 2520]; 0/absent = preset default. THE cost/quality knob of the Depth page — production reuses the depth artifact when depth_res + fps match the preview's. Prices the depth share by `clamp((depth_res/depth_res_base)², 0.5, 4)`. |
| `depth_scale` | stereo_preview, production | [0.3, 1.5]; globally scales the profiler's depth script |
| `depth_model` (POST /v1/conversions) | mobile one-shot flow | `vda` (default) \| `da2` (per-frame relative DA2 — matches the mobile app's on-device model, ~10× cheaper than vda) |
| `inpaint` | stereo_preview (default `none`), production (default `propainter`) | `none` = splatted, `migan` = per-frame fast fill (preview ×`migan_preview_multiplier`, production ×`migan_production_multiplier`), `propainter` = temporal inpaint (stereo_preview pays `inpaint_multiplier`) |
| `warp` | stereo_preview, production | (S3D-29: with neither `warp` nor `inpaint` sent, these steps default to `backward` — "Stretched" — and inpaint none; an explicit inpaint keeps the forward warp it implies; MI-GAN stays in the API) stereo synthesis method: `forward` (splat + occlusion masks, pipeline default) or `backward` (gather warp — the mobile app's kernel; no gaps open). `backward` forces `inpaint: none` (so no `inpaint_multiplier`) and is rejected alongside an explicit `inpaint: propainter`; rejected on depth_preview. Forwarded to Modal as `warp` only when set |
| `scene_overrides` | stereo_preview, production | per-scene `{first, displacement?, shot_type?, placement?, passthrough?}`; `first` must be 0 or a CURRENT scene cut, strictly increasing; displacement (0, 0.03]; shot_type close_up\|standard\|dynamic\|wide; placement `[far, near]` (index 0 = far plane, index 1 = near/pop-out — matches splat semantics), −1.5 ≤ far < near ≤ 1.5; `passthrough: true` ships the scene as 2D (both eyes = source, no warp/inpaint — end credits etc.) and is mutually exclusive with the other keys; ≥ 1 key per entry |
| `formats` | stereo_preview (default `["sbs"]`), production (default `["mvhevc","half_sbs"]`) | allowlist; depth_preview is fixed to `["anaglyph"]` (the UI centers the `depth_vis` output) |

When a pro video conversion succeeds and its job metadata carries a
`depth_script` with `first_src`/`last_src` entries, the gateway folds it into
the project as `scene_profile` (served on GET /v1/projects/{id}): the
profiler's measured per-shot `shot_type`/`displacement`/`placement` in
SOURCE-frame space, which the web Stereo page seeds its per-scene editors
from. Latest succeeded run wins; `scene_profile.scenes_version` says which
scene-list version it was computed against (stale after a cut edit).

## Lifelike 3D (method per project, 2026-11-03)

A project's `method` is `lifelike` or `classic` (always in project and
conversion JSON; records without one are classic). `POST /v1/projects`
takes an optional `method`; none means classic, so clients that predate
Lifelike keep working (the web app always sends one and preselects
lifelike in its UI); `PATCH /v1/projects/{id}
{"method": ...}` switches it for the next runs, one way only: classic →
lifelike at any time (earlier files stay); lifelike → classic is 400
`method_switch_not_allowed`, runs or not (Classic is being retired). A new
project naming `method: "classic"` is 400 `method_unavailable` (S3D-44);
only a missing method (old clients) still creates classic. Classic pro
steps stop at 3K: preset `4k` is 400 `preset_unavailable` (S3D-12; the
mobile one-shot keeps 4k). `/v1/limits` methods carry `new_projects`
(classic false). Lifelike without the
service → 400 `method_unavailable`. `GET /v1/limits` carries
`methods.{lifelike,classic}.{max_source_duration_s, available}` (0 =
unlimited) and `default_method`, the method the UI preselects (lifelike
wherever the service is configured).

Lifelike runs on the shared lifelike3d Modal service (ml-sharp-modal
`docs/LIFELIKE_API.md`, ADR-0019) — same submit/job shape, so the state
machine, billing and settlement are the Classic ones. Its steps:

| step | knobs |
|---|---|
| `lifelike_preview` | `from_frame`/`to_frame` required, 2–10 s of source (`lifelike_preview`); preset; formats (default `["sbs"]`); `target_fps` (half the source rate = quick look); one GPU |
| `production` | preset; formats ⊆ `mvhevc`/`sbs`/`half_sbs` (default `["mvhevc","half_sbs"]`); trim; `split_max_seconds` 60–3600 |

Qualities (S3D-04): Lifelike keeps the source's shape and sizes by the
short side per eye — `1080p|qhd|3k|4k|5k|6k|8k` (no draft; 5k 2880, 6k
3240, 8k 4320 since S3D-48), each offered only when
the source's short side (rotation-proof, rounded down to even) reaches it.
Between steps or below 1080 a `full` option renders the next step up (which
Lifelike clamps to the source) and costs the step below (1080p below 1080).
Projects and Lifelike quotes carry `qualities: [{id, label_short_side,
preset, price_preset}]`; requests send `preset` = an id (`full`, or the
preset `full` renders); quotes return `output_short_side`. Anything else
above the source is 400 `preset_above_source`; nothing above 8K is built
(bigger sources are scaled down, and Lifelike has no pixel cap). Only the
sizes in `lifelike_enabled_presets` (default 1080p, qhd, 3k, 4k — 5k/6k/8k
join once the Lifelike service renders them) are offered, quoted or run; a
request for another is 400 `preset_unavailable` before any charge. As a
backstop, a Lifelike 400 at submit fails the run at once with its money
returned and answers 400 `preset_unavailable` / `submit_rejected`. `original_eye`
(`left`|`right`|null) passes through on Lifelike steps at the same price;
above 4K (5k/6k/8k, or a full option above 2160p) it is always on — absent
or null means `left` — and qualities/quotes mark those
`original_eye_required: true` (S3D-65). Supersampling is Lifelike's own
default (S3D-66): nothing to send.
`foveation: "static"` passes through only when the size is below the
source's, at ×`foveation_price_multiplier` (its own `foveation_cents`
breakdown line), and only while `foveation_enabled` is on (else 400
`feature_unavailable`). Once on, it is the DEFAULT whenever the size is
below the source (previews too); only an explicit `"foveation": null`
turns it off. Off, nothing changes. Classic-only
knobs (`depth_res`, `depth_scale`, `inpaint`, `warp`, `scene_overrides`,
`use_uploaded_depth`, `displacement`) are 400s; the project's cut list is
always forwarded. Classic refuses `split_max_seconds` (400
`split_unsupported`) until the stereo3d pipeline implements splitting.

Bitrate (S3D-56, both methods, every step): `bitrate` = `auto` (default)
| `match_source` (the analyzed stream's bit_rate, else file size × 8 /
duration, capped at 200 Mbit/s) | 20 | 40 | 60 | 100 (Mbit/s). Resolved
into `params.output_bitrate_bps` and sent to either pipeline as
`output_bitrate_bps` (absent = auto; pipelines that don't support it yet
ignore it). Same price; quotes add `estimated_size_bytes` (one file at that
bitrate over the output length) when a rate is set. The mobile one-shot
never sends it.

Quotes gain `method`, `charge_timing` (`before` above
`precharge_threshold_cents`), `eta_seconds` from the method's model,
`output_seconds` and `split_suggested` (output > 900 s). Conversions gain
`method`, `charge_timing`, `waiting_for_gpu`/`queued_s` (copied from the job
record, both pipelines), `parts` (`[{index, from_frame, to_frame, start_s,
duration_s}]` for split outputs) and, for pre-charged runs, `billing.status`
`charged` → `refund_pending` → `refunded` (or `not_charged` when 3DS was never
completed); a batched run that failed or was canceled reads `not_charged`.
A Lifelike job that waited past its 6 h queue cap fails with error code
`servers_busy`. Cancel (both methods, pre-charged or batched): any time
before submission or while the run waits in line for a GPU with nothing
started, then for a minute after it starts (`cancelable`, and
`cancelable_until` once started); pre-charged runs are refunded in full,
batched ones never charged. `GET /v1/conversions/{id}/downloads` adds `files`: one entry per
output (`name`, `format`, `part` for split parts, `filename` like
"Trip_4K_part2_spatial.mov" for project runs, `url`); `downloads` (name → URL) is unchanged.

Pricing: Lifelike production has its own PRICE table (no margin),
`lifelike_price_cents_per_minute` per output minute at 24 fps, times the fps
factor; the bulk discount applies, nothing else from Classic. A Lifelike
preview costs its frames at the same price per frame (price per minute /
1,440, times seconds × frame rate), at least `minimum_cents`, with no bulk
discount. The 50¢ per-run minimum applies to every pro step of both methods
(S3D-17). A quote may carry `method` to price the step as if the project
used that method (validated by that method's rules; the project is not
changed; the response's `method` says which) — the chooser's side-by-side
price and ETA. On conversions a `method` other than the project's is a 409
`method_mismatch`.

`GET /v1/pricing` (public, no auth, `Cache-Control: max-age=300`) is the
price list from the live config: both methods' per-minute customer prices
(Classic production as a default quote on a 16:9 24 fps source; Classic
previews as base rates), the Lifelike preview price, the fps rule, bulk
discount, per-run minimum, pre-charge threshold, and per-method length and
file-size limits. The grouped (batch) charge is internal (S3D-21): its
window and cap never reach the public list. Every conversion carries one
customer-facing `payment`: `pending` (billed later / its grouped charge is
still to run), `paid`, `refunded`, `not_charged` or `payment_needed` (its
grouped charge failed, or a pre-charge awaits the bank's check).

Batching (S3D-19): the tiers set window and cap by collected spend —
new accounts 1 h / $50; $200 collected 4 h / $150; $1,000 12 h / $400;
$5,000 24 h / $1,000 (`batch_tiers[].window_hours`). A declined automatic
charge within `batch_failure_lookback_days` (90) drops the account to the
first tier, window AND cap (the larger tab is for a good paid record).
`batch_window_hours`, when set, overrides every window (the test env sets
0.25). A failed charge no longer locks downloads (S3D-22): new paid pro
steps answer 402 `payment_method_needed` until the card is fixed and the
retry (settle / pay-now) succeeds; quotes stay open; the mobile one-shot
keeps `billing_overdue`; account deletion still collects dues first.
`GET /v1/projects` items gain `summary: {latest_state, latest_step,
spent_cents}` (spent counts charged, pre-charged, batched and owed runs; not
refunded or uncharged ones). `POST /v1/projects/{id}/delete` soft-deletes a
project (409 while a run is active): it and its runs answer 404 and leave
the lists; the record stays and its files are purged 30 days later (see
File keeping). Download `files`
entries carry `size_bytes`; links are signed afresh on every GET. Project
runs download as `<original stem>_<resolution>[_partN]_<layout>.<ext>`
(S3D-31: layout `spatial` .mov, `SBS`/`HSBS`/`TB`/`HTB` .mp4; resolution
as customers see it — 1080p, 1440p, 3K, 4K…, a full-resolution run its real
`1606p`; the stem cut to 200 bytes at a character boundary), carried on the
signed URL as Content-Disposition (ASCII `filename` + UTF-8 `filename*`)
and as `files[].filename`; a name a project already produced becomes
`name (2).ext`, oldest run first. The mobile one-shot's links are
unchanged and carry no `filename`.

Source files: `POST /v1/uploads` may send `bytes` and `method` to be refused
up front over that method's cap (`lifelike_max_source_bytes`, 25 GiB;
Classic `max_source_bytes`, 8 GiB); project creation and a switch of method
check the stored size (400 `source_too_large`). ETA: `overhead_s + render_gpu_s_per_minute ×
output minutes (24 fps) / GPUs + encode_tail_s` (the encode runs in
parallel chunks, so the tail is flat; previews use `preview_tail_s`). Overdue judging adds the
run's `queued_s`, and a run may process for max(24 h, 3 × its estimate).

Billing (both methods): pro steps quoted above `precharge_threshold_cents`
are CHARGED on the saved card before submission (`auto_precharge`; 3DS parks
them at `created`, the succeeded webhook submits) and refunded in full when
they fail, are canceled or expire; smaller ones join the batch on success as
before. The mobile one-shot flow keeps its hold. PaymentIntent metadata
carries `method` (and `split_max_seconds`).

Config keys (`config/pricing_{env}`, every one optional):

| key | default |
|---|---|
| `lifelike_max_source_duration_s` | 0 (unlimited); Classic keeps `max_source_duration_s` (600) |
| `lifelike_max_gpu_workers` | 4 (clamped to 8, like `max_gpu_workers`) |
| `precharge_threshold_cents` | 2500 |
| `pro_minimum_cents` | 100 — every paid pro-step run of both methods (S3D-17) |
| `preview_minimum_cents` | 100 — previews (lifelike_preview, depth_preview, stereo_preview) |
| `minimum_cents` | 50 — unchanged: the mobile one-shot's floor and the smallest grouped charge |
| `lifelike_price_cents_per_minute` | 1080p 300 · qhd 450 · 3k 700 · 4k 850 · 5k 1300 · 6k 1600 · 8k 2200 (S3D-11) |
| `foveation_enabled` / `foveation_price_multiplier` | false / 1.3 |
| `lifelike_enabled_presets` | `["1080p","qhd","3k","4k"]` |
| `lifelike_preview` | `min_s` 2 · `max_s` 10 · `default_s` 5 |
| `lifelike_max_source_bytes` | 25 GiB; Classic keeps `max_source_bytes` (8 GiB) |
| `lifelike_eta` | `render_gpu_s_per_minute` 530 · `overhead_s` 45 · `encode_tail_s` 150 · `preview_tail_s` 30 |
| `gpu_cap_per_app` | 8 — GPUs per Modal app, the "busy N of cap" in the GPU-line mail |
| `file_keep_days` | 90 — days without use before a project's files are erased (S3D-24) |
| `file_notice_days` | `[14, 3]` — notice mails, days before |
| `deleted_project_purge_days` | 30 — a deleted project's files are kept this long |

Env: `LIFELIKE_BASE_URL` (test defaults to the test service, prod is off
unless set; `off` disables), `LIFELIKE_TOKEN_ID`/`LIFELIKE_TOKEN_SECRET`
(default to the Modal token).

### File keeping (S3D-24)

A project's stored files — the original upload, proxy and thumbnails, a
depth upload, every run's outputs (`outputs/<job>/` of its analyze,
profile and run jobs) — are erased after `file_keep_days` without use.
Use = `GET /v1/projects/{id}`, starting a run (`POST …/conversions`), a
download, or `POST /v1/projects/{id}/keep` (→ `{project_id,
files_delete_at: null}`); each restarts the clock (written at most hourly
unless a notice already went out). Projects show `files_delete_at` only
once a deletion is scheduled (inside the 14-day window), and
`files_deleted_at` after the erase; then downloads, quotes, runs,
analyze/profile and depth uploads answer 410 `files_deleted`. Records and
billing stay. Notices: one mail per account per notice listing its
projects ("Stereo3D Studio: files of N projects will be deleted on …"),
14 and 3 days before; a project is erased only once its last notice went
out its full lead time ago (a late notice moves the date). Deleted
projects (`POST …/delete`) are erased 30 days after deletion, no notices.
Accounts deleted through `/v1/account/delete` are skipped (manual purge).
A source shared with a re-created project stays until the last of them
goes; a project with a run in progress waits.

The sweep runs from the reconciler at most hourly (`ops_{env}/file_keeping`);
its first run dates every existing project (last change + 90 days, never
sooner than 14 days out, so everyone gets both notices). Test env: only
test accounts — the owner's (`OWNER_ALERT_EMAIL`) and
`FILE_KEEPING_TEST_ACCOUNTS` — are real, their notices mailed to the
owner's address; every other test project is a dry run (notices and
erases logged, nothing mailed or erased). Prod is real for everyone.

### GPU-line alert (S3D-34)

Every reconcile sweep (each minute) looks for customer runs that have had
`waiting_for_gpu` for more than 60 s (`modal.waiting_since`, set by the
status poll). While any exist the owner (`OWNER_ALERT_EMAIL`, set by
deploy.sh to the KPI-alert address) gets "Stereo3D Studio: N runs waiting
for a GPU": account email, method, step, resolution, length, waited so far,
busy GPUs per method vs `gpu_cap_per_app` (estimated from the runs in
progress at their worker caps), oldest wait. At most one mail per 15 min
per line; when the line empties, one "GPU line cleared" mail with the
longest wait. The throttle lives in `ops_{env}/gpu_line`, so instances
agree. No address or no Resend key → logged only.

## Support runbook

A user ticket should quote a `conversion_id` (the app shows it on every
error). With it:

1. **Firestore** `conversions_{env}/{id}` — full record: params, source
   probe, quote, state history timestamps, `error.internal_message` (full
   Modal error, never sent to the client), `stripe.payment_intent_id`,
   `modal.job_id`.
2. **Stripe dashboard** — search the PaymentIntent (or by
   `metadata.conversion_id`); metadata links back to conversion + user.
3. **Modal** — `modal.job_id` for pipeline logs; the job record in the Modal
   Dict keeps per-stage timings and cost.
4. **Cloud Logging** — filter `jsonPayload.conversion_id="..."` for the
   gateway's request trail.
5. **Slack** — every failure and every failed capture/cancel (money needing
   manual follow-up) is posted as it happens.

Reading a pro-step ticket ("my production looks different / cost more than
the preview"):

- `params.depth_res` on the two conversions is the first thing to compare —
  it is the depth quality knob AND a price multiplier. The quote's
  `breakdown.depth_res_factor` shows exactly what it did to the price
  (`clamp((depth_res/depth_res_base)², 0.5, 4)` on the depth share);
  `breakdown.inpaint_multiplier` explains a stereo_preview priced above the
  flat per-minute rate. If depth_res or target_fps differ between preview and
  production, the depth artifact was NOT reused — expect both a different
  look and no depth reuse discount.
- `params.scene_overrides` + `scenes_version` on the conversion say which
  per-scene tweaks ran, validated against which scene list. Compare with the
  project's `scene_profile` (what the adaptive profiler measured on the last
  succeeded run, and what the Stereo page seeded its sliders from). A
  `scene_profile.scenes_version` older than `scenes.version` means the user
  edited cuts after the profiled run.

## Deployed environments

Both live in GCP project `spatial-video-studio` (the Firebase project the
mobile app and web client authenticate against), region `us-central1`:

| env | Cloud Run service | Modal backend | Stripe mode |
|---|---|---|---|
| test | `stereo3d-gateway-test` | `stereo-crafter-test--stereo3d-api-test.modal.run` | test keys |
| prod | `stereo3d-gateway-prod` | `spatial-video-studio--stereo3d-api-prod.modal.run` | live keys |

Browser clients are admitted by the CORS middleware; `CORS_ORIGINS`
(comma-separated origins, default `*`) narrows it once the web domains are
final. Auth is bearer-token only (no cookies), so reflected origins carry no
credential risk.

## One-time setup (per project/env)

```bash
# Service account
gcloud iam service-accounts create stereo3d-gateway-$ENV
# roles: datastore.user; storage.objectAdmin (scope to the bucket);
# secretmanager.secretAccessor; iam.serviceAccountTokenCreator on ITSELF
# (required for V4 signed URLs under ADC).

# Secrets (Secret Manager)
#   stripe-secret-key-$ENV, stripe-webhook-secret-$ENV, stripe-publishable-key-$ENV
#   modal-token-id, modal-token-secret        # modal token new --name gateway
#   reconcile-token-$ENV                      # any random string
#   slack-webhook                             # optional, shared with the Modal app

# Deploy
GCP_PROJECT_ID=... MODAL_WORKSPACE=stereo-crafter-test ./deploy.sh test

# Stripe webhook (dashboard → Developers → Webhooks): <service-url>/webhooks/stripe
#   events: payment_intent.amount_capturable_updated,
#           payment_intent.canceled, payment_intent.payment_failed,
#           payment_intent.succeeded          # pay-as-you-go charge settlement

# Reconciler (Cloud Scheduler, every minute)
gcloud scheduler jobs create http stereo3d-gateway-$ENV-reconcile \
  --schedule='* * * * *' --http-method=POST \
  --uri="<service-url>/internal/reconcile" \
  --headers="X-Reconcile-Token=<reconcile-token-$ENV>"

# Firestore composite indexes:
#   conversions: (uid ASC, created_at DESC)        — GET /v1/conversions
#   conversions: (project_id ASC, created_at DESC) — project conversion history
#   projects:    (uid ASC, created_at DESC)        — GET /v1/projects
gcloud firestore indexes composite create --collection-group=conversions_$ENV \
  --field-config field-path=uid,order=ascending \
  --field-config field-path=created_at,order=descending
gcloud firestore indexes composite create --collection-group=conversions_$ENV \
  --field-config field-path=project_id,order=ascending \
  --field-config field-path=created_at,order=descending
gcloud firestore indexes composite create --collection-group=projects_$ENV \
  --field-config field-path=uid,order=ascending \
  --field-config field-path=created_at,order=descending
```

The Modal deployment must have proxy auth enabled (see repo root: the
`fastapi_app` endpoint sets `requires_proxy_auth=True`), and the
`modal-token-*` secrets must hold a proxy-auth token from that workspace.

## Pricing

Rates load from Firestore `config/pricing_{env}` (60s cache; code defaults in
`internal/pricing/pricing.go` if the doc is absent). Defaults anchor on the
old app's ~$1/min at 1080p, scaled by preset GPU cost:

| field | default |
|---|---|
| `cents_per_minute` | draft 25 · 1080p 100 · qhd 150 · 3k 200 · 4k 300 |
| `image_cents` | 5 (per paid still past `free_images_per_day`; always batched, never charged alone) |
| `minimum_cents` | 50 |
| `discount_threshold_cents` / `discount_pct` | 1000 / 0.10 |
| `depth_preview_cents_per_minute` / `stereo_preview_cents_per_minute` | 10 / 25 |
| `analyze_credit_cents` | 0 (legacy first-conversion credit; analysis is free outright) |
| `stage_shares` | depth 0.35 · preprocess 0.05 |
| `depth_res_base` | 980 (the depth_res that prices at 1×) |
| `inpaint_multiplier` | 1.6 (stereo_preview with inpaint=propainter) |
| `migan_preview_multiplier` / `migan_production_multiplier` | 1.15 / 0.5 (inpaint=migan — the fast per-frame fill on the L4 lite tier) |
| `eta_migan_scale` / `eta_raw_warp_scale` | 0.5 / 0.35 — WALL-time scales on the stereo/encode ETA residual for the lite-tier modes (decoupled from the price multipliers; anchored on docs/RUNLOG.md 2026-09-01) |
| `production_no_inpaint_multiplier` | 0.4 (production with inpaint=none, i.e. `warp: backward` — production rates bake ProPainter in and the backward warp runs on the cheap L4/NVENC tier; applies to the whole subtotal and the ETA residual) |
| `max_duration_s` | 1800 |
| `max_source_bytes` | 8 GiB |
| `max_active_per_user` | 3 |

Edit the Firestore doc to change prices or caps — no deploy needed. Bump
`rate_version` when you do; every quote records the version it was priced
under.

## Development

```bash
go build ./... && go test ./...
```

There is no local emulator wiring; test against the `test` env (its Modal
workspace, Firestore collections `*_test`, and Stripe test keys are all
isolated from prod).
