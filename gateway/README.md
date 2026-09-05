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
delinquent — results stay available, new paid steps are blocked until
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
| `warp` | stereo_preview, production | stereo synthesis method: `forward` (splat + occlusion masks, pipeline default) or `backward` (gather warp — the mobile app's kernel; no gaps open). `backward` forces `inpaint: none` (so no `inpaint_multiplier`) and is rejected alongside an explicit `inpaint: propainter`; rejected on depth_preview. Forwarded to Modal as `warp` only when set |
| `scene_overrides` | stereo_preview, production | per-scene `{first, displacement?, shot_type?, placement?, passthrough?}`; `first` must be 0 or a CURRENT scene cut, strictly increasing; displacement (0, 0.03]; shot_type close_up\|standard\|dynamic\|wide; placement `[far, near]` (index 0 = far plane, index 1 = near/pop-out — matches splat semantics), −1.5 ≤ far < near ≤ 1.5; `passthrough: true` ships the scene as 2D (both eyes = source, no warp/inpaint — end credits etc.) and is mutually exclusive with the other keys; ≥ 1 key per entry |
| `formats` | stereo_preview (default `["sbs"]`), production (default `["mvhevc","half_sbs"]`) | allowlist; depth_preview is fixed to `["anaglyph"]` (the UI centers the `depth_vis` output) |

When a pro video conversion succeeds and its job metadata carries a
`depth_script` with `first_src`/`last_src` entries, the gateway folds it into
the project as `scene_profile` (served on GET /v1/projects/{id}): the
profiler's measured per-shot `shot_type`/`displacement`/`placement` in
SOURCE-frame space, which the web Stereo page seeds its per-scene editors
from. Latest succeeded run wins; `scene_profile.scenes_version` says which
scene-list version it was computed against (stale after a cut edit).

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
