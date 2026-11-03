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

### Payment prerequisites (spec v6 §P)

- **P1** Webhooks route by object type; non-PaymentIntent objects answer
  200 untouched until their handlers land. Every PaymentIntent event acts
  only on the record's current PaymentIntent; `canceled` never expires a
  run the gateway canceled itself or whose PaymentIntent was replaced.
- **P2** `processing` is never paid: runs read `pi_status=processing`
  (billing `waiting_for_payment`, payment status `processing`), groups
  stay charging with `pi_status=processing`; nothing is submitted,
  credited or tiered until `succeeded` (webhook or `sweepProcessing`).
- **P3** A request with an `Idempotency-Key` gets the run id
  `IdemConversionID(env, uid, key)` and Firestore `Create`: a racing twin
  loses the create and replays the winner (pro steps and the mobile
  one-shot; mobile ids without a key are unchanged).
- **P4** `statement_descriptor_suffix` on every PaymentIntent: `STEREO3D`
  (web, `metadata.product=svs-web`), `SVS CLOUD` (the app's cloud runs);
  the account prefix is `SPATIAL AI`.
- **P5** Customer creation carries the key `customer_{env}_{uid}`.
- **P6** "payment method", never "card", in messages.
- **P7** `DefaultMethod`: any reusable type (card, Link, PayPal); an
  existing default is never replaced; with none, the OLDEST saved method
  becomes default. `/v1/billing` sends `card` only for a card default and
  adds `default_method {type, wallet?, brand?, last4?, email?}`.
- **P8** (a) A pre-charge is recorded first (`created`, `pi_status
  charging`, with the method and receipt email it uses), then charged
  with `precharge_{env}_{id}`; `redrivePrecharges` replays a record whose
  request died. (b) Owed-item reads aren't capped at 10. (c) Refunds name
  their amount, and the key includes it.

### Payment layer rules (spec v6 C1, E0)

- **C1 flow per run** (`decideFlow`, `payment_flow` on quotes and runs):
  China mode (`X-Client-Mode: china`) → `china`; nothing saved, every
  method failed, or `sheet_only` → `paynow` (`pay_now_reason`); credit (a
  saved method in `paid_methods`) and ≤ `precharge_threshold_cents` →
  `after`; otherwise `precharge`. Accounts that paid before the layer
  (lifetime > 0, no paid list yet) count as credit until the backfill.
- **Pre-charge**: recorded first; try 1 the default, try 2 the last good
  method (if different, not a stop code, try 1 under 25 s, no network
  retry: `confirm_{pi}_{pm}_1`). A bank check or two declines cancel the
  PaymentIntent and leave the run `created` with `payment_flow=paynow`,
  `pay_reason=authentication|declined` (P3 sheet); a stop code also sets
  the account `sheet_only`.
- **E0-1** `current_payment {kind, id, expires_at}`: `replaceRunPayment`
  closes the old object (paid → the run is paid, nothing new), creates,
  then CAS-swaps; a lost swap closes its own object.
- **E0-2** `applyRunPayment`: money on a non-current object is adopted
  while the run is unpaid (the previous object is closed; if it paid
  too, refunded), refunded in full once the run is paid or terminal.
- **E0-3** `expires_at` = object expiry + 5 min (30 min without one);
  `resolveRunClocks` closes the object before expiring a run.
- **E0-4** groups are charged under a lease (`acquireBatchLease`); only
  the gateway writes failure.
- Account facts: `last_good_method`, `paid_methods`,
  `all_methods_failed`, `sheet_only`, `under_review`.

### Checkout and Billing (spec v6.2 D1–D4, F)

- **Sheet**: runs with `payment_flow` paynow are written `created` and get a
  Checkout Session (`ui_mode=elements`, API `2026-10-28.endive`, raw form
  calls in `stripex/checkout.go`/`web.go`) on the web's own PMC
  `STRIPE_PMC_WEB` ("Stereo3D web", test `pmc_1UXYkVAVV5NpxADI3Vj4kzJI`),
  forced save for card/Link/PayPal with Stripe's reuse text, tax ID
  collection, 30-min expiry, `statement_descriptor_suffix=STEREO3D`, key
  `run_{env}_{conversion_id}_{attempt}`. WeChat Pay is excluded unless
  `X-Client-Device: computer`; Klarna is excluded while `klarna_markets` is
  empty. Responses: `billing {status: requires_payment, reason,
  declined_method_label?, checkout {client_secret, expires_at}}`, plus
  top-level `checkout`, `amount_cents`, `publishable_key`.
- `POST /v1/conversions/{id}/pay-now {ui: "elements", replace?}`: the open
  session, or a fresh one (E0-1 replace). 409 `already_paid` / `expired` /
  `payment_in_progress`. `{method}` (China) arrives with the China path.
- A pre-charge that needs the bank's check or was declined opens the sheet
  for that run in the same request (P3).
- Pro steps no longer 402 `no_payment_method` (C4); `requireRunnable`:
  410 deleted, 403 `under_review`, 402 `payment_method_needed {amount_cents}`
  while anything is owed.
- **D3** `checkout.session.completed` / `async_payment_succeeded` →
  `applyRunPayment`; a saved method gets a consent record
  (`consents_{env}`), `allow_redisplay=always`, the default (if none, or
  after P3), `last_good_method`, and the request IP as tax evidence;
  `expired` / `async_payment_failed` on the current session expire the run.
- **Billing (ours, no Stripe portal on the web)**: `GET /v1/billing/methods`
  (backup order, default first, `removable`, `remove_blocked_reason`,
  `max: 5`), `POST /v1/billing/methods/setup` (setup session; 409
  `too_many_methods`, 429 `too_many_adds` past 3 a day),
  `POST /v1/billing/methods/{id}/default`, `PUT /v1/billing/methods/order
  {ids}`, `DELETE /v1/billing/methods/{id}` (409 `method_needed` for the last
  one while anything is owed/open/charging; removing the default promotes
  the first backup), `GET/PUT /v1/billing/company`,
  `POST/DELETE /v1/billing/company/tax-ids`.
- The test webhook endpoint carries every D5 event; `/webhook` is served
  as an alias of `/webhooks/stripe`.

### Owed money, backups, hand-off, limits (spec v6.2 C5, C10, C11, B7, B14, B17, G3)

- **Backups (C5)**: a group charge that fails for a non-transient reason
  tries the account's other saved methods in its backup order (`PUT
  /v1/billing/methods/order`), key `confirm_{pi}_{pm}_1`; when all fail the
  group is `failed` (soft declines retried once after 24 h by the
  reconciler), `all_methods_failed` is set, a stop code makes the account
  `sheet_only`, and mail E2 goes out.
- **Settle (C11)**: one function, `collectOutstanding(uid, trigger)`,
  scopes every failed group and charge-failed run into `settles_{env}/{uid}_{n}`
  in ONE transaction (one live settle per account; items frozen as
  `settling`), cancels old per-run PaymentIntents, then charges: `sheet`
  (Checkout Session "Your last runs", key `settle_{env}_{id}_{attempt}`),
  `ios_settle` (default method only, key `settle_{env}_{id}`; a bank check
  holds the settle 30 min), `soft_retry`/`delete` (with backups). Paid →
  every item paid in one transaction; money on an ended settle is refunded.
  The reconciler resolves settles past their lease from the payment object
  before releasing them, runs the 24 h soft retry (E3 on failure, E5 on
  success) and the day-7 reminder (E4).
- `POST /v1/billing/settle`: empty body → today's iOS shape `{settled,
  requires_action, client_secret, publishable_key, message}`; `{ui:
  "elements"}` → `{checkout {client_secret, expires_at}, amount_cents, runs,
  payment_state open|processing|paid, settled, more_owed_cents}`.
- **Outstanding lock (C10)**: while anything is owed, web project downloads
  answer 402 `payment_needed {amount_cents}` (the live settle's frozen
  amount when one is open). The mobile one-shot keeps `billing_overdue`.
  Account deletion collects first: 402 `balance_due {amount_cents,
  settle_id, publishable_key}` when it can't.
- `GET /v1/billing` adds `outstanding {amount_cents, settling, runs?,
  payment_state?}` (only when owed), `has_payment_method`, `flow_state
  credit|saved|sheet|under_review`, `limits`.
- **China (B7, BL-20)**: `pay-now {method: "alipay", return_url}` makes the
  run's payment a server-side Alipay PaymentIntent and answers `next_action
  {type: redirect, redirect_url}`; `wechat_pay` → 400 `method_unavailable`
  (not offered in USD on this account). Settles have no China path yet
  (China runs pay at start, so they don't owe).
- **Hand-off (B17)**: `POST /v1/conversions/{id}/handoff {email?}` →
  `{code, url, expires_at, amount_cents, email_masked?}` (expires the
  headset's session; 8-char Crockford code, one per run; E7 mails the
  link). Public, 5 tries/IP/min: `GET /v1/handoff/{code}` (read-only:
  `{label, amount_cents, currency, email_masked, china, expires_at, state
  open|paying|paid|expired, confirming?}`) and `POST
  /v1/handoff/{code}/pay {return_url?, method?}` → `{url}` (hosted session)
  or, China, `{next_action}`. `return_url` must be on `SITE_URL`. The web
  renders the QR code from `url`.
- **Limits (B14)**: an account with no saved method and no payment keeps 3
  web projects and 10 GB of uploads: 403 `save_method_for_more {limited,
  reached, projects_left, bytes_left, max_projects, max_bytes}` on project
  create / web upload; quotes carry `limits`. Any payment (`paid_once`) or
  a saved method lifts them.
- **Mails (G3)**: E1 (paid at start, production, before queueing), E2–E5,
  E7 through Resend, claimed once in `mails_{env}`; on test every customer
  mail goes to `OWNER_ALERT_EMAIL` with "(test)".
- File keeping (M5): the erase clock and its notices pause while the
  account owes; it restarts when it clears.
- `payment_method.detached` (a method removed outside our API) drops it
  from the account facts and the backup order.

### Invoices and purchase history (spec v6.2 C6, F, P10)

- **Charge records** `charges_{env}/{kind}_{id}` (`run_…`, `group_…`,
  `settle_…`) are written when the money is final: a paid group, a
  paid-at-start run that succeeded, a paid settle (one line per run), a
  settle item found paid alone. They hold the invoice job's state
  (`pending|invoicing|done|failed|skipped`, attempt `n`, lease) and, with
  the refund layer, `refund_seq`.
- **Invoice job** (reconciler, every minute): `invoices.create` (key
  `inv_{env}_{charge_id}_{n}`, `currency` explicit — an invoice otherwise
  takes the account's GBP and refuses USD items —, `auto_advance=false`,
  `pending_invoice_items_behavior=exclude`, `effective_at` = paid time,
  the C3 footer, metadata `env/product/charge_id`; the id is stored at
  once), one item per run (key `invitem_…_{conversion_id}`, missing lines
  only), total must equal `amount_received` (else Slack + `failed`, left as
  a draft), finalize, `attach_payment`, credit notes for refunds made
  before (`cn_{env}_{re}`, `email_type=none`), then the hosted URL and PDF.
  A failed step resumes next minute (8 tries, then `failed` + Slack); a
  voided invoice restarts as `n+1`; refunded in full before invoicing →
  `skipped`. `tax_mode=inclusive` adds automatic tax (a tax failure
  finalizes without it and alerts). Hourly void sweep: our open invoices
  with no payment after 1 h, unless their job holds a live lease.
  `invoice.finalization_failed` / `invoice.overpaid` → Slack. Verified end
  to end in Stripe TEST (`stripex/livecheck`, `STRIPE_TEST_KEY`).
- `GET /v1/billing/invoices?limit=25&starting_after=in_…` → `{invoices:
  [{invoice_id, number, created_at, amount_cents, currency, pdf_url,
  hosted_url, credit_notes?: [{id, number, created_at, amount_cents,
  pdf_url}]}], has_more}` (ours only; drafts and voids left out).
- `GET /v1/billing/history?limit=25&starting_after={row_id}` keeps
  `entries`/`next_cursor` for older clients and adds `rows`, `has_more`,
  `tax off|inclusive`. A row: `{row_id, kind charge|refund|outstanding,
  created_at, amount_cents (negative for refunds), currency, status
  paid|processing|payment_needed|refunded|partially_refunded, payment_method
  {label}, invoice {hosted_invoice_url, invoice_pdf}, receipt_url,
  credit_note_url, help_ref, items [{conversion_id, project_id,
  project_name, step, preset, from_frame, to_frame, amount_cents}]}`. One
  row per statement charge (a settle is one row; the groups and runs it
  paid aren't repeated), plus one "Payment needed" row on the first page
  while the account owes. `refund_requested`/`disputed` and `case_id`
  arrive with the refund layer.

### Prepaid balance (spec v7.1 §N, web only)

- **Ledger**: `balances_{env}/{uid}` (summary) + `entries/{id}`
  (append-only: topup, hold, settle, release, debt_payment,
  refund_to_balance, expiry, adjustment, dispute_*, cash_refund). Every
  change is one transaction writing the entries and the summary; E0-8
  refuses `balance + reload_in_flight − held − frozen < 0`. FIFO spending
  (non-cash credits first), `fifo_used` on settles for refunds.
- **Runs**: C1 picks `balance` first when available covers the quote (hold
  = quote after discounts, at least $1). Submit writes the run and its hold
  in ONE transaction, then queues it. The run's terminal transition settles
  (succeeded: min(max(delivered, $1), hold)) or releases (anything else)
  inside the same `store.Transition` (R3); the reconciler closes any hold
  left on a terminal run. Short with auto-reload on: the hold is
  `pending_reload`, the run waits (`waiting_for_payment`) for a reload of
  max(Y, shortfall in whole dollars, $10); a failed reload releases it and
  the run falls back to the sheet. Balance runs have no card charge, group
  or invoice. N6 spend limit: 403 `spend_limit_reached`.
- **Top-ups**: `POST /v1/billing/balance/topup {amount_cents, ui:
  elements|hosted_page}` → `{checkout {client_secret, expires_at},
  topup_id, publishable_key, amount_cents, url?}`; China `{amount_cents,
  method: alipay, return_url?}` → `{topup_id, redirect_url, next_action}`.
  $10–$500, first top-up ≤ $100, ≤ $1,000 a day: 422 `amount_out_of_range
  {min, max}`. Credited once per PaymentIntent (entry `topup_{pi}`); a
  second payment of the same top-up is refunded. Then: an invoice
  (charge `topup_…`, top-up footer), E13, waiting runs start, debts paid.
- **Auto-reload**: fires only on a downward crossing of X by `balance −
  frozen` (holds ignored), armed again at X or above; one in flight
  (`reload_in_flight`), 5 a day; record first (`topups_{env}`, `charging`),
  off-session with backups, key `topup_{env}_{id}`; never with a debt,
  under review or sheet_only. Failure: paused (`declined|stop_code|limit|
  review|sheet_only`), E15; resumed by the customer or a top-up.
- **Debts (N9)**: when a debt is recorded, on every top-up, and on `POST
  /v1/billing/settle {source: "balance"}` (402 `insufficient_balance
  {required_cents, available_cents}`), C11 pays it from the balance
  (`debt_payment`, key `debt_{settle}`) when the balance covers it all;
  E5. App one-shot debts included (R10).
- `GET /v1/billing/balance` (also `balance` on `GET /v1/billing`):
  `{balance_cents, held_cents, held_runs, frozen_cents, available_cents,
  expires_at, expired, never_topped_up, auto_reload {enabled, below_cents,
  add_cents, paused_reason?}, spend_limit_cents, month_spent_cents,
  low_balance_cents, reload_in_flight?, currency}`.
- `PUT /v1/billing/balance/settings {auto_reload?, spend_limit_cents?
  (null clears), low_balance_cents?}` → the summary; 409 `method_needed`,
  409 `auto_reload_blocked`, 400 `invalid_auto_reload` (Y ≥ $10, ≤ $500,
  ≥ X). Turning auto-reload on records consent `reload-v1-2026-11`.
- `GET /v1/billing/balance/entries?starting_after=` → `{entries: [{id,
  kind topup|auto_reload|refund_to_balance|debt_payment|cash_refund|
  expiry|adjustment|dispute_*, cents (signed), at, detail?}], has_more}`.
- `GET /v1/billing/usage?month=YYYY-MM&starting_after={conversion_id}`
  (`&format=csv` for the month) → `{rows: [{at, project, project_id,
  conversion_id, method, preset, step, minutes, cost_cents (null while
  running), paid_with balance|card|alipay, status done|running|released|
  returned, reserved_cents?, returned_cents?}], has_more, month}`.
- Quotes add `payment_flow: balance` and `balance {available_cents,
  enough, reload_cents?}`; runs' `billing.status` reads `balance_hold`,
  `balance_settled {charged_cents, released_cents}`, `balance_released`,
  or `waiting_for_payment` while a reload runs. History lists each top-up
  ("Balance top-up · $25.00").
- Expiry 12 months after the last top-up: E16 at 30 and 7 days, then the
  unheld part expires (E17); money landing later expires again, a refund
  to the balance reopens it (R5). Low-balance mail E14, once per crossing.
- Account deletion: debts from the balance first, then 409
  `balance_remaining {cents}` unless `{balance_confirmed: true}` (Slack
  asks for the closure refund until cases land).
- Not yet: API keys (N10), cash refunds and dispute freezes on top-ups
  (with cases, step 6), the nightly M3 checks.

Invariant tests run against the Firestore emulator and a fake Stripe:
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8786 go test ./internal/api ./internal/store`
(skipped without the emulator).

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
sizes in `lifelike_enabled_presets` (default 1080p, qhd, 3k, 4k on prod;
every size on test, where lifelike3d-test renders 5k/6k/8k) are offered,
quoted or run; a
request for another is 400 `preset_unavailable` before any charge. As a
backstop, a Lifelike 400 at submit fails the run at once with its money
returned and answers 400 `preset_unavailable` / `submit_rejected`. `original_eye`
(`left`|`right`|null) passes through on Lifelike steps at the same price;
above 4K (5k/6k/8k, or a full option above 2160p) it is always on — absent
or null means `left` — and qualities/quotes mark those
`original_eye_required: true` and `experimental: true` (S3D-65; runs carry
`experimental` too, and the job's `metadata.experimental` is kept).
Up to 4K `original_eye` stays optional and off unless sent (S3D-48).
Each quality lists its `formats`: full-width `sbs` stops at 5K — at 6K and
8K (by the preset sent, also for a full option rendering 6k/8k) a run
asking for `sbs` is 400 `format_unavailable`, and a preview renders
`half_sbs` instead of `sbs`. Supersampling is Lifelike's own default
(S3D-66): nothing to send. `output_bitrate_bps` applies to every format.
Cost: Lifelike's `cost_summary.total_usd` is now ≈ the bill (model ×1.2);
`modal.cost_usd` keeps it and `modal.cost_usd_raw` the model figure.
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
| `foveation_enabled` / `foveation_price_multiplier` | false (test: true) / 1.3 |
| `lifelike_enabled_presets` | `["1080p","qhd","3k","4k"]` (test: all seven) |
| `lifelike_preview` | `min_s` 2 · `max_s` 10 · `default_s` 5 |
| `lifelike_max_source_bytes` | 25 GiB; Classic keeps `max_source_bytes` (8 GiB) |
| `lifelike_eta` | `render_gpu_s_per_minute` 530 · `overhead_s` 45 · `encode_tail_s` 150 · `preview_tail_s` 30 |
| `gpu_cap_per_app` | 8 — GPUs per Modal app, the "busy N of cap" in the GPU-line mail |
| `gpu_cap_per_workspace` | `{}` — per-workspace override of `gpu_cap_per_app` (S3D-40) |
| `pro_discount_enabled` / `pro_discount_pct` | false (test: true) / 0.20 — S3D-67 |
| `file_keep_days` | 90 — days without use before a project's files are erased (S3D-24) |
| `file_notice_days` | `[14, 3]` — notice mails, days before |
| `deleted_project_purge_days` | 30 — a deleted project's files are kept this long |

Env: `LIFELIKE_BASE_URL` (test defaults to the test service, prod is off
unless set; `off` disables), `LIFELIKE_TOKEN_ID`/`LIFELIKE_TOKEN_SECRET`
(default to the Modal token).

### Pricing 2026-11 (TEST only; prod defaults unchanged)

`tier_pricing`, `free_previews_enabled` and `plans_enabled` default on for
test only (pricing proposal 2026-11, BL-19, owner-approved for test).

- **Tiers**: Studio > Business (web plan) > Pro (SVS Pro entitlement or a
  running pass) > list. Lifelike per output minute at 24 fps (fps factors
  unchanged): list 1080p 400 · 1440p 550 · 3K 800 · 4K 1000 · 5K 1600 · 6K
  2000 · 8K 2800; Pro 340/470/680/850/1360/1700/2380; Business
  300/410/600/750/1200/1500/2100; Studio 280/385/560/700/1120/1400/1960.
  Classic: 15/25/30% off its production prices.
- **Bulk**: 10% off runs over $50 (list total), never stacked: a run gets
  the bigger of bulk and its tier. Quotes add `discount {kind: tier|bulk,
  tier?, cents, pct}`, `tier`, `tier_label`; the older keys stay
  (`pro_discount_cents` = the tier's saving, `discount_cents` = bulk).
- **Add-ons** on the base at the run's tier: Foveated +30%, Master bitrate
  +20% (`bitrate: "master"`: 60–300 Mbit/s by size), Express +50%
  (`express: true`, Lifelike; included in Business and Studio). Express
  sends `"priority": "express"` and `max_gpu_workers` 8
  (`lifelike_express_gpu_workers`) to the Lifelike service, which gives
  freed GPU slots to Express first; standard runs omit `priority` (the
  service defaults to standard and promotes standard jobs after 30 min).
  The gateway's own queue (the reconciler's submit of paid runs) also
  takes Express first. The job's echo (`metadata.priority`,
  `max_gpu_workers`) is stored on the run (`modal.priority`,
  `modal.max_gpu_workers`) and Express runs carry
  `modal.express_cost_factor` (`lifelike_express_cost_factor`, 1.12: 8 vs
  4 GPUs measured +9-12%) for cost reporting. Quotes add `express_eta
  {eta_seconds, standard_eta_seconds, max_wait_seconds}` (planning and
  the encode don't shrink: about a minute saved on a 60 s clip, about 2x
  only from 3 min; an Express job may still wait up to
  `lifelike_express_max_wait_s`, 420 s, for a running standard piece).
  Lifelike runs in `GET /v1/conversions/{id}` add `priority`,
  `max_gpu_workers` (echoed) and, while an Express run waits for a GPU,
  `queue_wait_max_seconds`.
- **Free previews** per period, no rollover: Pro Weekly 5/week, Monthly 20,
  Yearly 240/year, passes 60/120, Lifetime 20/month, Business 50, Studio
  200; non-subscribers 1 on their first project; 20 a day. One per 5 s,
  doubled for 5K–8K and 60 fps. A free preview quotes $0
  (`payment_flow: free_preview`, breakdown `free_preview`,
  `price_without_free_cents`), takes its previews at submit
  (`previews_{env}`), and gives them back if it delivers nothing (inside
  its terminal transition). Quotes carry `free_previews {allowance, used,
  remaining, daily_left, units, free, intro, resets_at?}`.
- **Plans**: `POST /v1/billing/plan {plan: business|studio, ui}` →
  subscription-mode Checkout (`{checkout, url?, plan, publishable_key}`;
  409 `plan_active`); `POST /v1/billing/plan/cancel {resume?}`.
  `GET /v1/billing` adds `plan {plan, name, status, active, monthly_cents,
  credit_cents, credit_left_cents, current_period_end,
  cancel_at_period_end}`. Prices by lookup key `svs_web_{tier}_monthly`
  (test: Business $299, Studio $999). `customer.subscription.*` mirrors
  the plan; `invoice.paid` grants the period's credit ($400 / $1,500) as
  non-cash plan credit in the balance ledger (spent first, never paid out,
  expired at the period's end or replaced by the next grant). Plans raise
  the concurrent-run cap (3 / 8).
- **Previews download**: preview runs output `sbs` + `mvhevc` by default
  (half_sbs above 4K) and download like any run, named
  `<stem>_<res>_preview_<layout>.<ext>`.
- `GET /v1/pricing` adds `pricing_model: tiers`, `tiers
  {lifelike_cents_per_minute {list, pro, business, studio}, classic_pct}`,
  `addons`, `plans`, `free_previews`, and `discount.stacks_with_tier:
  false`.

### Lifelike stabilization (config only)

`config/pricing_{env}.lifelike_stabilize` (bool, default false on test and
prod) sends `"stabilize": true` on every Lifelike run created while it is
on (~15% less shimmer on moving content, +5% GPU; LIFELIKE_API.md). Each
run records it (`params.stabilize` in Firestore, never in API responses
and not settable by clients), so the owner's A/B can tell runs apart.
Prices are unchanged.

### Pro discount (S3D-67)

Spatial Video Studio Pro customers get `pro_discount_pct` (20%) off every
paid web run — production of both methods, not previews — taken before the
10% bulk discount (which applies if the run is still over $10); the $1
minimum stays. Pro = RevenueCat's `pro` entitlement active (subscriptions,
Lifetime with no expiry, a billing grace period) or a pass
(`…_pass_<n>m…`, App Store or web) bought less than n months ago — the
app's own rule; `trial`/free grants don't count. The gateway asks
RevenueCat REST v1 (`GET /v1/subscribers/{firebase uid}`, secret
`RC_API_KEY_V1`, the SVS backend's) on each pro-step quote/run, caching 10
min per uid (failures 1 min). Any failure or no key = list price, never a
block. Quotes answer `pro: bool` and, when applied, `pro_discount: {pct,
cents}`; the stored breakdown keeps `pro`, `pro_discount_pct`,
`pro_discount_cents`. `/v1/pricing` adds `pro_discount: {pct,
applies_to}` (pct 0 = off). The mobile one-shot is unchanged.

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

### Modal workspaces (S3D-40)

A project lives in one Modal workspace, recorded at creation
(`projects.workspace`; runs copy it to `conversions.workspace`). Every
submit, status poll, reuse lookup and cancel of a project and its runs —
analyze, profile, Classic and Lifelike — goes to that workspace's
endpoints; an unknown workspace is never routed elsewhere (the request
answers 503, sweeps leave the run to its deadline). Records without the
field read as the default workspace: `MODAL_WORKSPACE_ID` (deploy.sh passes
`MODAL_WORKSPACE`), else the workspace in `MODAL_BASE_URL`'s host. Its
endpoints/tokens are the existing `MODAL_BASE_URL`, `LIFELIKE_BASE_URL`,
`MODAL_TOKEN_*`. More workspaces (none today): `MODAL_WORKSPACES`, JSON
`[{"id","modal_base_url","lifelike_base_url","token_id_env",
"token_secret_env"}]`, tokens named by env var (mounted secrets). New
projects go to the default (`assignWorkspace`, the place to balance by
load later); `/v1/limits` Lifelike availability describes that workspace.
Workspace ids must stay stable once projects carry them. GPU caps and the
GPU-line alert are per workspace.

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

### Refunds, cases, disputes and the admin API (spec v6.1 step 6)

**Policy** (`config/refund_policy_{env}`, optional, cached 60 s; code
defaults fill every missing key — prod and test use the same defaults):

| key | default |
|---|---|
| `reasons.{reason}` | auto: `run_failed_undelivered`, `cancel_undelivered`, `cancelled_by_us`, `deletion_undelivered`, `late_or_duplicate`, `topup_withdrawal`; manual: `partial_failure`, `delivered_run`, `quality_complaint`, `support_request`, `efw`, `dispute`, `refund_failed`, `dashboard_unassigned`, `unpaid_run`, `closure_balance`; unknown reasons are manual |
| `manual_above_cents` | 5000 (an auto reason over $50 turns manual unless in `cap_exempt`) |
| `cap_exempt` | the six auto reasons above |
| `deadline_business_days` | 2 (18:00 in `timezone`) |
| `reminder_hours` | 48 |
| `timezone` | Asia/Tokyo |
| `dispute_alert_pct` | 0.0075 |
| `notify.slack_channel`, `notify.owner_emails` | empty → the gateway Slack webhook and `OWNER_ALERT_EMAIL` |

**Cases** (`cases_{env}`, ids `CASE-0001…` from `counters_{env}/cases`):
types `refund | dispute | efw | support | waive | balance_refund`;
statuses `waiting_for_run | open | waiting_on_customer | decided |
refund_pending | closed` with `result` (`refunded | denied | waived |
superseded | duplicate | reclassified | stopped | dispute_won | dispute_lost |
nothing_left | …`). One open case per `dedupe_key` (a second request
adds a `request_merged` event); a closed case is final. Every change
writes `cases_{env}/{id}/events`; evidence snapshots (runs, payments,
refunds, earlier cases, log and Stripe links) go to `…/evidence`.
Unfinished runs are cancelled as ours (auto) or wait (`waiting_for_run`,
reclassified by the sweep when they end); unpaid runs open a `waive`
case; delivered runs open a manual case.

**Ledger and serialization** (`refunds_{env}/{pi}_{case}_{k}`):
`ReserveRefund` runs in one transaction on the charge document
(`charges_{env}`, `refund_seq`): refundable = charge lines − rows that
count (pending + succeeded + out_of_band), capped by Stripe's remainder
minus unsent pending rows. The Stripe idempotency key is
`refund_{env}_{pi}_{case}_{k}`; a transient error leaves the row
`pending` and the reconciler replays the same key. Dashboard refunds
(`refund.created/updated`) are matched to a pending row (W1) or recorded
`source: dashboard` with a `dashboard_unassigned` case. Credit notes are
written for refunds on invoiced charges (amount only). A refund on a
disputed charge is refused.

**Disputes / EFW** (webhooks `charge.dispute.*`,
`radar.early_fraud_warning.created`, `refund.*`): a dispute opens a
`dispute` case (dedupe `dispute:{id}`, deadline = evidence due),
supersedes other open cases on the charge, locks the charge's downloads
(403 `disputed`), puts the account on sheet-only, pauses auto-reload and
freezes a disputed top-up. Won → unlock/unfreeze; lost → `dispute_loss`
balance entry, no new debt. An EFW cancels undelivered runs as ours,
pauses auto-reload and opens a manual `efw` case.

**Balance refunds** (`balance_refund` cases): `topup_withdrawal` within
14 days of a top-up pays the unspent part back to that top-up's card at
once (auto) and the held part when the holds end; `closure_balance`
(account deletion with a cash balance) is manual and pays Σ unspent cash
top-ups newest first. Plan credit and admin credits never pay out. A
`cash_refund` entry leaves the balance first; a failed refund puts it
back.

**History rows** (additive): `status` may be `refunded`,
`partially_refunded`, `refund_requested`, `refund_failed`, `disputed`;
`case_id` when a case is open; refund rows (`type: refund`) from the
ledger.

**Mails**: E6 refunded (card / outside Stripe / to balance / waived),
E9 under review, E10 denied (templates `delivered`, `outside_terms`,
`other`), E11 question, E12 refund failed; owner notices O1 (new
manual case/dispute), O2–O4 reminders/overdue, O5 refund failed.

**Admin API** — only for `ADMIN_ORIGINS` (default
`https://admin.stereo3d.studio`; test adds
`https://admin-test.stereo3d.studio`, `http://localhost:5174`), a
Firebase ID token with custom claim `svs_admin: true` and a second
factor (`firebase.sign_in_second_factor`). Errors: 403
`origin_not_allowed`, 401 `invalid_token`, 403 `no_access`, 403
`mfa_required`; money actions need `auth_time` within 5 minutes (401
`reauth_required`). Every call is audited in `admin_audit_{env}`;
responses are `no-store`.

| route | |
|---|---|
| `GET /v1/admin/cases?tab=open\|waiting\|decided\|closed\|all&type=&reason=&mode=&cap=over\|under&q=` | `{cases:[{id,type,reason,mode,status,result,opened_at,age_hours,email_masked,requested_cents,max_refundable_cents,deadline_at,deadline_red,dispute_due,last_activity_at}], counts:{open,overdue,due_today}}`; disputes first, then EFW/refund_failed, then oldest |
| `POST /v1/admin/cases` `{uid, conversion_ids, reason, text, topup_id}` | opens cases (balance reasons need `topup_id` for withdrawals) → `{cases:[page]}` |
| `GET /v1/admin/cases/{id}` | page: `{case, runs, max_refundable_cents, events, evidence, related_cases, hints, banners, account, refunds, actions}` |
| `POST /v1/admin/cases/{id}/actions` `{action, items, expected_max_cents, template, text, method, reference}` | actions `note, customer_reply, refresh_evidence, ask, approve, partial, waive, deny, no_refund, mark_out_of_band, assign, stop_run, accept_dispute, counter_dispute, counter_with_refund_proof, close`; 409 `action_unavailable`, 409 `amount_changed` when the maximum moved → the page |
| `GET /v1/admin/accounts/{uid}` | `{account:{uid,email,deleted,stripe_customer_id,sheet_only,sheet_only_reason,under_review,blocked,owed_cents,lifetime_paid_cents,plan,balance,…}}` |
| `POST /v1/admin/accounts/{uid}/actions` `{action, cents, case_id, note}` | `clear_review, clear_sheet_only, block, unblock, resend_e2, write_off_owed, adjust_balance` (needs `case_id`); `block` → 403 `account_blocked` on new runs |
| `GET /v1/admin/disputes/summary?months=1..24&format=csv` | A4: `{months:[{month,charges,disputes_activity,disputed_cents_activity,disputes_by_payment,activity_pct,won,lost,accepted,countered,lost_cents,dispute_fees_cents,efw,efw_cents,efw_refunded,efw_became_disputes}], reference_pct, win_rate, counter_rate, open, by_method, by_flow, by_country, scope, account_wide, denominator, generated_at}` |
| `GET /v1/admin/policy` | `{policy, edit_in}` |
| `GET /v1/admin/mail-previews` | rendered E6/E9–E12 samples |

Still not built: the admin console app itself.

### Download log, M3, block list, credit notes and svs-admin (spec M8, M3, H, C8, M1)

**Download and play log (M8)**: `downloads_{env}/{auto_id}`
`{uid, conversion_id, project_id, file, kind, at, ip_country, ip_hash,
user_agent, expire_at}`. One row per signed URL handed out by
`GET /v1/conversions/{id}/downloads` (`kind: download_issued`) and per
play the web reports with **`POST /v1/conversions/{id}/plays {file,
kind: view_in_3d|preview}` → `{logged: true}`** (optional; older clients
just leave no play rows). Rows are queued and written in batches (every
2 s, flushed on SIGTERM). `ip_hash` is a salted SHA-256 (`IP_HASH_SALT`,
else derived from the reconcile token); the raw IP is never stored.
`ip_country` comes from the first of `X-Client-Region`,
`X-Client-Country`, `X-Client-Geo-Country`, `CF-IPCountry`,
`X-Appengine-Country`. Cloud Run adds none, so the load balancer needs a
custom request header `X-Client-Region: {client_region}` (owner, infra).
Kept 13 months: `expire_at` is ready for a Firestore TTL policy
(`gcloud firestore fields ttls update expire_at
--collection-group=downloads_{env} --enable-ttl`), and M3 deletes rows
past 13 months anyway. Case evidence (M7) lists them under `downloads`.

**M3 nightly reconciliation**: once a day from the minute reconciler
(the first sweep after 18:00 UTC = 03:00 JST, claimed by
`counters_{env}/m3_{date}`), or on demand (`POST /v1/admin/reconcile
{since_hours, dry_run}`, `svs-admin reconcile`). It searches this env's
`svs-web` PaymentIntents of the last 48 h (Search API, paced) and checks
the E0 invariants. Flags: `no_record` (refunded, late_or_duplicate),
`not_current` (replayed through the webhook path: E0-2 adopt or refund),
`double_paid`, `no_invoice` (after 1 h), `invoice_mismatch`,
`open_invoice`, `refund_no_record`, `invoice_overpaid`,
`run_past_expiry`, `balance_mismatch` (balance ≠ Σ entries, or held ≠ Σ
holds), `topup_entries` (a paid top-up without exactly one topup entry),
`leaked_hold` (an open hold on a terminal run). The report goes to Slack
and to `reconcile_reports_{env}/{id}` `{id, env, since, at, dry_run,
payment_intents_searched, counts, flags[{flag, ref, uid, cents, detail,
action}], errors, downloads_deleted, duration_ms}` for the KPI stack.

**Block list (H, B11)**: `blocklist_{env}/{fingerprint}` `{fingerprint,
reason: dispute|efw|manual, source_id, uid, pi, brand, country, by, note,
at, hits, last_hit_at}`. A dispute or early fraud warning adds the card
by itself. At the gate, a default card on the list gets 403
`payment_method_blocked` (runs and top-ups), and the backup loops skip
listed cards. A payment that still succeeds with one is refunded in full
(undelivered runs cancelled as ours, delivered ones a manual case,
top-ups withdrawn), the account goes under review and Slack is told.
`GET/POST /v1/admin/blocklist {action: add|remove, fingerprint, note}`.

**Credit notes per line (C8 step 4)**: a refund the ledger knows the
runs of credits those runs' invoice lines (`lines[][invoice_line_item]`
plus `refunds[][refund]`); money returned outside Stripe gets
`out_of_band_amount` on its lines. A Dashboard refund with no runs, an
invoice with automatic tax, or a per-line note Stripe refuses falls back
to amount-only. The refund path and the invoice job both use it.

**Deletion waits for the closure case (N8 step 3)**: `POST
/v1/account/delete {balance_confirmed: true}` with cash in the balance
now answers **202 `{deleted: false, deletion_pending: true, case_id,
refund_cents, message}`** and keeps the account (new runs and top-ups get
403 `deletion_pending`; auto-reload pauses). The account is deleted when
the closure case is decided (an admin decision, or the cases sweep).
Asking again while pending answers the same 202. Without cash (plan
credit only) the deletion goes ahead at once.

**svs-admin**: `go run ./cmd/svs-admin [-env test|prod] <command>`:
`cases`, `case`, `act` (case actions, `-items c1=100`, `-expected-max`),
`open`, `account`, `account-action`, `disputes [-csv]`, `policy`,
`mail-previews`, `reconcile [-since 48h] [-dry-run]`, `blocklist
[add|remove FP]`. It calls the same handlers in process (same audit
rows, `who: cli:$USER`), reads keys from Secret Manager with gcloud
(never printed) and asks before money actions unless `-yes`.

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
