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
- **P4** `statement_descriptor_suffix` on every PaymentIntent: `SV STUDIO`
  (web, `metadata.product=svs-web`; was `STEREO3D` until the web app was
  renamed Spatial Video Studio, owner 2026-11-04), `SVS CLOUD` (the app's
  cloud runs). The account prefix is `SPATIALVID` (owner 2026-11-04; was
  `SPATIAL AI`), so a web charge reads "SPATIALVID* SV STUDIO" (21 of
  22). The gateway never changes account settings (the account is
  shared). Plan subscriptions take no suffix (Checkout in subscription
  mode has none), so `invoice.created` sets the whole line as
  `statement_descriptor` on a Business/Studio invoice while it's a draft
  (renewals; idempotent), built from the account's prefix read live
  (cached 1 h, fallback `SPATIALVID`) and cut to 22. The first invoice,
  which Checkout finalizes at once, keeps the account's default. The
  webhook endpoint must send `invoice.created`.
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
  collection, 30-min expiry, `statement_descriptor_suffix=SV STUDIO`, key
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
  $10–$500, first top-up ≤ $100: 422 `amount_out_of_range {min, max}`;
  over the $1,000-a-day cap: 422 `topup_daily_cap {min, max,
  day_left_cents, day_cap_cents, resets_at}` (UTC day). Credited once per PaymentIntent (entry `topup_{pi}`); a
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
  409 `auto_reload_blocked {reason: under_review | dispute |
  payment_failed | deletion_pending}` (under review = an early fraud
  warning or a blocked card; dispute = sheet-only after a dispute),
  400 `invalid_auto_reload` (Y ≥ $10, ≤ $500,
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

A project's `method` is `lifelike` or, for projects made earlier,
`classic` (always in project and conversion JSON; records without one
are classic). **Classic 3D is retired for new projects (owner
2026-11-04).** `POST /v1/projects` with `method: "classic"` is 422
`classic_retired` ("Classic 3D is no longer available for new
projects."); a missing method now means lifelike (422 `classic_retired`
where Lifelike isn't configured). A Classic project that never ran
Classic gets 422 `classic_retired` on analyse retry, profile, depth map,
quote and run, and can switch: `PATCH /v1/projects/{id} {"method":
"lifelike"}` works at any time and keeps the Classic outputs
downloadable; lifelike → classic stays 400 `method_switch_not_allowed`.
A project that already ran Classic (a submitted or delivered run,
remembered as `classic_ran`) keeps its files, downloads, plays and
further Classic runs. `GET /v1/pricing` carries `classic_new_projects:
false` so the web hides Classic; Classic prices stay for those projects.
The mobile one-shot route isn't a project and is unchanged. Classic pro
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
  2000 · 8K 2800; Pro (15% off) 340/470/680/850/1360/1700/2380; Business
  (20% off) 320/440/640/800/1280/1600/2240; Studio (25% off)
  300/410/600/750/1200/1500/2100 (owner 2026-11-04; was 25%/30%).
  Classic: 15/20/25% off its production prices.
- **Whole minutes (owner 2026-11-04)**: production (both methods) is
  priced on `billable_minutes = ceil(the customer's video in the
  converted range ÷ 60)`, on the run's total (a split run is one range:
  7:40 + 7:40 → 16, not 8 + 8; the brand intro never counts); then the
  per-minute rate, fps factor, tier and add-ons as before. Quotes carry
  `billable_minutes` beside `billable_seconds`; receipts and invoices
  show just the minutes, never the exact length: invoice lines "{project}
  · Lifelike 3D render · 4K · 60 fps · 3 min" and web payment
  descriptions (Stripe's receipt) "Lifelike 3D render · 4K · 60 fps · 3
  min" (previews "… · 5 s"; the mobile one-shot keeps its own). Holds and charges are the quote, so a settle never exceeds it.
  Previews keep their exact length (Lifelike: per frame; Classic
  depth/stereo previews: per second) and the mobile one-shot is
  unchanged. The $1 minimum and the bulk threshold are unchanged.
- **Frame rates above 30 fps need a Business or Studio plan (owner
  2026-11-04)**, every method, previews included (the mobile one-shot is
  unchanged). Without one, a faster source runs at the largest
  whole-number division of its rate at most 30 (60 → 30, 59.94 → 29.97,
  50 → 25, 48 → 24, 120 → 30, 100 → 25, 90 → 30, 40 → 20): params carry
  `target_fps` and `fps_capped: true`. An explicit `target_fps` above 30
  is 422 `plan_required_fps` ("Frame rates above 30 fps need a Business
  or Studio plan."); so is an uploaded depth map on such a source (it
  needs every frame). Checked at the quote and again when the run is
  created. Quotes add `fps {max_fps (30|120), source_fps, target_fps,
  target_fps_choices, fps_capped, reason?: plan_required_above_30fps}`;
  `/v1/pricing` `fps` adds `max_fps_without_plan: 30, max_fps_with_plan:
  120`. Prices are unchanged (the fps factor against 24). **The web
  names the rate**: a web run (request with one of our CORS origins) on a
  source above 30 fps without `target_fps` is 422 `fps_choice_required`
  with `details.target_fps_choices`; API callers keep the default.
- **Counted frames (VFR guard, 2026-11-04)**: when an analyze job
  completes, the gateway counts the source's frames from the file, not
  the header (`probe.Count`: MP4/MOV read their sample index, whose
  entries are the packets; other containers `ffprobe -count_packets`,
  which reads the whole file without decoding, 90 s cap). The project
  probe adds `counted_frames` and `vfr` (counted rate > stated × 1.01).
  Pricing uses the higher of the stated rate and counted ÷ duration; a
  source above 120 fps either way is refused at analyze and 400
  `source_fps_too_high` on quotes and runs. A count that fails leaves
  the header standing (logged). At settle, a project run whose job
  reports `video_frames` more than 1% over the frames it was quoted for
  (length × target or priced rate) still settles at the quote; Slack
  `frames_over_quote` and an owner-only support case
  (`frames_over_quote`, one per run) record it. The check reads the
  job's `metadata.video_frames` (the pipeline's billed count, ≈ duration
  × output fps, final at plan time) against the quote's length × rate,
  never `nb_frames` or duration × `r_frame_rate`. The pipeline's own
  read (3DS, 2026-11-04: VFR sources resampled to a constant grid at the
  measured average) is kept on the run (`modal.source_vfr`,
  `source_counted_frames`) and the project probe (`source_vfr`,
  `source_counted_frames`, first run that reports it). Its plan-time
  refusal "Frame rate above 120 fps is not supported." fails the run on
  the normal path (hold released or refunded, nothing charged) with code
  `source_fps_too_high` and "This video's frame rate is above 120 fps,
  which isn't supported."
- **Bulk**: 10% off runs over $50 (list total), never stacked: a run gets
  the bigger of bulk and its tier. Quotes add `discount {kind: tier|bulk,
  tier?, cents, pct}`, `tier`, `tier_label`; the older keys stay
  (`pro_discount_cents` = the tier's saving, `discount_cents` = bulk).
- **HDR output** (owner 2026-11-05): automatic and free for everyone, no
  add-on and no price line (HDR output, below).
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
  remaining, daily_left, units, free, intro, period, resets_at?}`;
  `period` is what the allowance counts over: `week` (Pro Weekly),
  `month` (Pro Monthly, Lifetime's calendar month, Business, Studio),
  `year` (Pro Yearly), `pass` (a pass's whole run), `first_project`
  (non-subscribers, no `resets_at`). `resets_at` is the period's end.
- **Plans**: `POST /v1/billing/plan {plan: business|studio, ui}` →
  subscription-mode Checkout (`{checkout, url?, plan, publishable_key}`;
  409 `plan_active`); `POST /v1/billing/plan/cancel {resume?}`.
  `GET /v1/billing` adds `plan {plan, name, status, active, monthly_cents,
  interval, price_cents, credit_cents, credit_interval, credit_left_cents,
  current_period_end, cancel_at_period_end, month_index?,
  credit_resets_at?}`. Prices by `stripe_price_id` in the code defaults
  (TEST: Business `svs_web_business_monthly` $299 a month; Studio
  `svs_web_studio_yearly` **$11,988 a year**; the old Studio monthly
  price is archived). `customer.subscription.*` mirrors the plan
  (`plan.interval`); `invoice.paid` grants the period's credit as
  non-cash plan credit in the balance ledger (spent first, never paid out,
  expired at the period's end or replaced by the next grant): Business
  $400 per monthly invoice. **Studio (yearly)** gets $1,500 every month of
  the year from the scheduler (every 10 min; month k starts on the
  subscription's monthly anniversary, the day clamped to the month's
  end; entry `plancredit_{sub}_m{k}`, once per subscription and month;
  Slack `plan_credit_failed`; M3 `plan_credit_missed` grants a missed
  one); unused credit ends with its month; its 200 free previews reset
  monthly. A dispute or fraud warning on the year's invoice, or a block,
  holds the grants back (`plan.grants_paused`) until won, cleared or
  unblocked; a normal cancel lets them run to the year's end. RevenueCat
  `studio` + `pro` run to the year's end + 3 days and are granted again
  on renewal. A Studio `plan_refund` proposes this month's unspent share
  (paid ÷ 12 × unspent ÷ credit) **plus the months not yet started pro
  rata** (paid ÷ 12 × n), flagged on the case and its row (`yearly
  {current_month_cents, months_not_started, future_months_cents,
  owner_decides: true}`); it is never refunded automatically. Plans raise
  the concurrent-run cap (3 / 8). `GET /v1/pricing` `plans.{tier}` carry
  `interval` (`month` | `year`), `price_cents` (per interval),
  `monthly_cents`, `credit_cents` and `credit_interval: "month"`.
- **Previews download**: preview runs output `sbs` + `mvhevc` by default
  (half_sbs above 4K) and download like any run, named
  `<stem>_<res>_preview_<layout>.<ext>`.
- `GET /v1/pricing` adds `pricing_model: tiers`, `tiers
  {lifelike_cents_per_minute {list, pro, business, studio}, classic_pct}`,
  `addons`, `plans`, `free_previews`, and `discount.stacks_with_tier:
  false`.

### Black bars (BL-03, owner 2026-11-03)

Lifelike runs take letterbox and pillarbox bars off by default; the user
is asked when bars are found and can keep them.

- **Bars.** Analysis stores `project.crop` (`W:H:X:Y`, cropdetect on
  decoded frames, so displayed pixels; `probe` is coded pixels, before
  rotation). `has_bars` is true when the crop is smaller than the frame
  turned to the crop's orientation by at least 8 px on a side or 2% of
  the picture, so a portrait clip's `1080:1920:0:0` on a 1920x1080 probe
  is no bars. Classic's depth ceiling uses the same rule.
- **Setting.** `PATCH /v1/projects/{id} {remove_bars: bool}` (422
  `sample_project` on the sample). Project responses carry `crop`,
  `has_bars`, `remove_bars` (true when there are bars and the user
  hasn't kept them; false without bars) and `bars_removal_available`
  (a Lifelike project and `lifelike_source_crop_enabled`: code default
  off, on for test).
- **Run.** A run that takes bars off records `params.remove_bars: true`
  and `params.source_crop: {x, y, w, h}` (displayed source pixels, fixed
  at creation); the admin run rows show it as `bars_removed` (null when
  the run kept the whole frame).
- **Lifelike call.** Such a run's `/convert` body carries `source_crop:
  {x, y, w, h}` (the recorded crop, as is) on every path: full runs,
  previews, split runs (one submit) and Express. Absent = the whole
  frame. Lifelike ignores unknown keys, so test runs keep working until
  3DS ships it (feat/source-crop).
- **Sizes and price.** With bars off, sizes are Lifelike's
  `crop_output_size` (live on lifelike3d-test, 1d23c0e), integer for
  integer: the crop's long edge at the step's long edge (16:9 of its
  short side), never above its own, the other side from the crop's
  aspect rounded half up to even (4K: 3840x1600 from a 3840x1600 crop,
  1080p: 1920x800; a 4:3 2880x2160 crop at 1080p: 1920x1440). The steps
  offered go by that long edge (a step is reached when its long edge fits
  the crop), and a full option's label is its real short side. A crop
  keeping under 20% of a side, under 256 px, or off the frame, isn't bars
  (Lifelike refuses it); the crop sent is made even (x, y up, w, h down),
  as Lifelike's yuv420 check needs. Lifelike's price is per step and output minute, so
  removing bars changes the price only when it changes the steps offered.
  Quotes add `output_width`, `output_height` (per eye, displayed pixels)
  and `remove_bars`; runs record `params.output_width` / `output_height`.
- **Full SBS and the H.264 level.** A full-width side by side doubles the
  eye's width; when the cropped picture's doubled frame passes H.264
  level 6.2 (139,264 macroblocks, Lifelike's `H264_MAX_FRAME_MBS`; a
  near-square crop at 5K: 2 x 4320 x 4320) Lifelike answers 400 "use
  half_sbs". The gateway treats it like 6K/8K: the size lists no `sbs`,
  a production asking for it is 400 `format_unavailable`, a preview swaps
  to half SBS, and Get another format answers `too_wide`.

### HDR output (owner 2026-11-05)

HDR sources get HDR output on Lifelike runs, automatically and free, behind
`lifelike_hdr_output_enabled` (code default off on test and prod).

- **Source dynamic range.** Analysis runs the gateway's ffprobe on the
  source (`color_transfer` arib-std-b67 = `hlg`, smpte2084 = `pq`, else
  `sdr`; the Dolby Vision record's `dv_profile` and
  `dv_bl_signal_compatibility_id`: profile 8 = `dv_8` with its base
  hlg/pq/sdr, profile 5 or compatibility 0 = `dv_5`) and stores
  `probe.dynamic_range` / `dynamic_range_base`. An HDR source is HLG, PQ,
  or DV 8 on an HLG/PQ base (DV 8.2's SDR base isn't).
- **Project.** `dynamic_range` and `hdr_source` only while the switch is
  on; `hdr_available` and `hdr_output` (the project's Lifelike runs come
  out in HDR) always, false while off.
- **Runs.** While on, every Lifelike run of an HDR source (full, preview,
  split, Express) records `params.hdr: true` and its `/convert` body
  carries `hdr_output: true`; SDR sources, Classic and the switch off
  change nothing. A request's `hdr` (older web builds) is ignored, never
  a 422. No price effect. Repack ("Get another format") ignores it for
  now.
- **dv_5.** No displayable base layer: analysis refuses it before any
  charge, whatever the switch, with "This video uses a Dolby Vision
  format that can't be converted…" (422 `source_unsupported` on a quote
  or run of a project that has it stored).

### Lifelike brand intro (BL-25)

Behind `config/pricing_{env}.lifelike_intro_enabled` (code default
**false** on test and prod until the pipeline's API is live): off, no
intro field is sent. On, every new Lifelike run records the intro at
creation and sends `intro_s` (3 on previews, 4 on every other run: free,
paid, Express) and `intro_language` (BCP-47) to the pipeline, which puts
it on the first part of a split video only. The language is the
account's saved `locale`, else the request's `Accept-Language`, else
`en`, normalised to the language alone except Chinese by script
(`zh-Hans`, `zh-Hant`) and Portuguese by region (`pt-BR`, `pt-PT`). The
intro is never billed: quotes, holds and charges use the customer's own
length (our probe and quote; the job's `video_frames`/`video_duration_s`
are recorded as `modal.video_frames`, `output_*` are never used). An
opt-out omits both fields. The run records the job's echo
(`modal.intro_s`, `intro_frames`) and the `brand_intro` cost stage
(`modal.brand_intro_usd`, inside `cost_usd`; other unknown stages are
ignored) for cost reporting. Only an account with an active Business or Studio plan can turn
it off (no intro fields sent); Pro and pay-per-video can't, and a saved opt-out
is ignored without such a plan.

- `GET /v1/account/settings` → `{lifelike_intro: bool, lifelike_intro_editable:
  bool, locale: string|null}`. `lifelike_intro` is true unless an active
  Business/Studio plan turned it off; `lifelike_intro_editable` is true
  only while such a plan is active.
- `PATCH /v1/account/settings {lifelike_intro?: bool, locale?: string|null}`
  → the same shape. `lifelike_intro` without an active Business/Studio
  plan: 409 `plan_required`. `locale` is normalised (`pt_BR` → `pt-BR`);
  an unparseable one is 400; `null` clears it (back to the browser's).

### Onboarding (owner 2026-11-04)

- **`GET /v1/account/settings`** adds `headsets` (string ids, `null`
  until answered), `hints_seen` (dismissed first-time hints) and
  `onboarding {welcome_done, checklist_hidden, tips_done, steps
  {first_video, first_preview, first_3d, watched}}`. The steps are worked
  out here and leave the sample out: a project of their own; a succeeded
  preview; a succeeded full run; their first play (`/plays`) or download
  of a run of their own (`customers.first_watched_at`). Accounts from
  before onboarding (a customer record or a project before 2026-11-04
  03:00 UTC) read `welcome_done: true` until they set it.
- **`PATCH`** takes `headsets` (replaces; ids `[a-z0-9_.-]`, at most 12),
  `hints_seen_add` (appends, at most 30 a call, 200 kept) and a partial
  `onboarding {welcome_done?, checklist_hidden?, tips_done?}`, besides
  `lifelike_intro` and `locale`.
- **`POST /v1/events {name, props}`** → `{logged: true}`: our own events
  in `events_{env}` with the uid and time. Allow-listed (400
  `unknown_event`): `onboarding_headsets {devices[], plan?, source?}`,
  other props dropped. 4 KB body, 30 an hour per account per instance
  (429 `rate_limited`).
- **`GET /v1/admin/onboarding/headsets?days=30`** (admin) → `{days,
  by_day[{day, device, count}], by_plan[{plan, device, count}],
  conversion[{device, people, converted}], generated_at}`. A person
  counts once per device (per day, per plan); `converted` = a priced full
  run that succeeded after their first answer, worked out when asked.
- **The sample**: a new account's first `GET /v1/projects` adds a
  finished Lifelike "Sunset session" (`sample: true`, 4K, 15 s at 25 fps)
  with a succeeded full run (`sample: true`, $0). Its files are the
  public CDN's `samples/2026-11/sunset-session-*` (preview: the 2D
  original; downloads: the spatial `.mov` and SBS `.mp4` as they are);
  nothing is copied per account (our bucket ages objects out at 90 days).
  Thumbnails are the web's own poster path. Quotes, runs, analyze,
  profile, depth map, scene edits and method switches answer 422
  `sample_project` ("This is a sample project. Add your own video to make
  3D."); archive, unarchive, rename and pin work as usual, delete is 409
  `sample_not_deletable` ("The sample can't be deleted. You can archive
  it."); file
  keeping never schedules or purges it; it's left out of `GET
  /v1/conversions`, the usage CSV, the month's spend, the download log
  and the onboarding steps. Its project and run ids are fixed per account
  (12 hex characters from a hash, like every id the routes take), so it's
  kept as account state: a sample that went missing (deleted under the
  earlier rule, or an old `smp…` id the routes refused, from before
  2026-11-04 05:00 UTC) comes back on the next list with proper ids,
  archived if it was archived; this also covers accounts from before the
  cutoff that had one. Account deletion takes it for good. For the sample's run, `GET /v1/conversions/{id}`,
  `/downloads` and `/plays` answer 200 (plays aren't logged), and
  `/handoff` answers 200 `{sample: true, nothing_to_pay: true}`.
- **`/v1/pricing`** plans add `max_fps: 120`.

### App Pro onboarding variant (owner 2026-11-04, test)

- **`onboarding.variant`**: `app_pro` while the account holds the app's
  Pro (an active "pro" entitlement bought in the App Store or the Mac App
  Store, or a promotional grant that isn't ours; RevenueCat's `store`),
  else `default`. Not app Pro: Pro bought on the web (`stripe`,
  `rc_billing`) or Pro that comes with Business/Studio (an active plan
  entitlement, or our promotional "pro" while our plan grant runs).
  **`onboarding.app_pro_welcome_done`** (PATCH `onboarding
  {app_pro_welcome_done}`): the app Pro welcome, once, also for web
  accounts that gain the app's Pro later (their `welcome_done` stays).
- **What the app knows** (read only from `app_users/{uid}`, which the app
  writes): `onboarding.headsets_from_app[]` in web ids, `onboarding
  .headsets_from_app_source` (`app_answer` | `app_device` | null) and
  `onboarding.app_viewing_device` (`apple_vision_pro` | `other_headset` |
  `screen_only` | null). The app asks one question (viewingDevice:
  appleVisionPro | otherHeadset | screenOnly); only Apple Vision Pro maps
  to a device (`avp`); "other headset" doesn't say which, so nothing is
  prefilled for it. Without an answer, the app having run on a Vision Pro
  (usedDevices RealityDevice…) gives `avp`.
- **Test only**: PATCH `simulate_app_pro: true|false` makes the account
  read as app Pro for the variant and the Pro price tier (Pro Monthly's
  preview allowance); logged as a warning; prod answers 403 `test_only`
  and ignores a stored switch.
- **Events**: `onboarding_headsets` takes `props.variant` (`default` |
  `app_pro`, `default` when absent); the admin onboarding report adds
  `by_variant[{variant, device, count, converted}]`.
- **`GET /v1/pro`** and **`POST /v1/pro/refresh`** add `free_previews
  {allowance, per_period, period: week|month|year|pass}` for a Pro holder,
  from the gateway's own table (`pricing.FreePreviewPeriods`,
  `FreePreviewAllowance`); the test switch reads as Pro there too (`via:
  simulated_app_pro`, Pro Monthly's allowance).

### Archive before delete (owner 2026-11-04)

- `POST /v1/projects/{id}/delete` (Delete) needs an archived project: 409
  `project_not_archived` ("Archive the project first, then delete it.").
  `DELETE /v1/projects/{id}` is archive, as before.
- Archiving (`DELETE /v1/projects/{id}` or PATCH `archived: true`) and
  deleting are refused while any run of the project isn't finished
  (created: waiting for payment or approval, a card hold included; paid;
  processing: in line for a GPU or rendering): 409
  `project_has_active_run` ("This project has a run in progress. Wait
  for it to finish, or cancel it, before archiving."). Was the same rule
  with code `conflict`.
- Account deletion and admin tooling don't use the route (the account is
  flagged and the sign-in removed; projects stay as records).

### Web feedback (owner 2026-11-04)

- **`POST /v1/feedback {kind: idea|problem|other, message (1–5000),
  email?, ok_to_contact, context {route, project_id?, run_id?, locale,
  user_agent, plan, isPro, app_version}}`** → `{id}`. Signed in or out
  (out needs an email; a bad token is still 401). 5 an hour per IP and
  per account (429 `rate_limited`).
- Stored in the app's store and shape: `app_feedback` on prod,
  `app_feedback_test` on test. Fields as the app writes them: `kind`
  (idea → `suggestion`), `text`, `email`, `platform: "web"`, `version` and
  `build` (the web commit), `device` (user agent, 64), `locale`, `isPro`,
  `uid` and `revenueCatID` (= uid) when signed in, `createdAt`, `via:
  "gateway"`; the web adds `okToContact`, `route`, `projectId`, `runId`
  (12-hex ids only), `userAgent` (300) and `plan`. Signed in, plan and
  isPro are the gateway's own; signed out, the page's.
- Mailed by the gateway to the owner's alert address, reply-to the
  sender: "[Spatial Video Studio] Suggestion · web <commit> · Pro (web)"
  (+ " (test)" on test). The document carries `mailingAt` from the start,
  the SVS backend's claim, so its app_feedback trigger doesn't mail it
  again; `mailedAt` or `mailError` follows. The KPI stack doesn't read
  app_feedback; the SVS backend's account deletion finds web documents by
  `uid` like the app's.
- **`GET /v1/admin/feedback?days=30&platform=`** (admin) → `{days,
  feedback[{id, collection, created_at, platform, kind, rating?, text,
  email?, company?, isPro, plan?, version, build, device, locale, uid,
  route?, projectId?, runId?, okToContact?, mailed, mailError?}],
  items[{id, platform, kind (web: idea|problem|other), message, email,
  ok_to_contact, app_version, context {route, project_id, run_id, locale,
  user_agent, plan, isPro, …}, created_at}], generated_at}` (items: the
  web admin's shape), newest first; on test it reads `app_feedback_test` and
  the app's `app_feedback` (read only).
  BL-29: rows and items add `plan_tier` (studio | business | pro | free:
  the sender's active web plan, else the message's isPro/plan). `GET
  /v1/admin/feedback/seen` → `{seen_at, updated_at}` (null when never
  set) and `POST /v1/admin/feedback/seen {seen_at}` keep one console-wide
  "seen up to" marker (`admin_state_{env}/feedback_seen`, no admin
  identity stored; a future time is taken as now).

### Business/Studio setup (owner 2026-11-04)

- **Events**: `business_setup_opened`, `business_setup_plan_picked
  {plan}`, `business_setup_details_done`, `business_setup_checkout_started
  {plan}`, `business_setup_purchased {plan}` (`plan`: business | studio,
  optional).
- **`settings.business_setup`**: GET `{team_size, main_use, headsets[],
  updated_at}` or null; PATCH `business_setup {team_size? (a number or a
  range like 2-5, 20+), main_use? (client_work | own_channel | stock |
  other), headsets?}` replaces the answers, `null` clears them.
- **`GET /v1/admin/onboarding/business_funnel?days=30`** (admin) →
  `{days, steps[{step, people, events, rate_from_previous}],
  by_plan[{step, plan, people}], business_setup[{step, people, by_plan
  {business, studio}}], answers {accounts, by_main_use[{main_use, count}],
  by_team_size[{team_size, count}]}, generated_at}`; the onboarding
  headsets report carries the same `business_setup`.
- **Company details** (owner 2026-11-04): Business and Studio Checkouts
  require the billing address (`billing_address_collection: required`)
  and offer an optional business name (`name_collection.business`) beside
  tax ID collection (all of it works with `ui_mode: elements`; Pro keeps
  the address optional). `checkout.session.completed` of a plan session
  stores `customer_details` as `customer.company` (company name = business
  name or name, address, tax IDs deduped, billing email = the Checkout
  email unless one is set, PO null) and syncs the Stripe Customer (name,
  address, tax IDs added if missing); a Pro Checkout counts only with a
  business name or tax ID. **`GET /v1/billing/company`** →
  `{company_name|null, address {line1, line2, city, postal_code, state,
  country}, tax_id {type, value, verification}|null, billing_email|null,
  po_reference|null}` plus the older `name`, `tax_ids[{id, type, value,
  verification}]` (the Stripe Customer is the source for name, address
  and tax ID; verification is Stripe's status: pending | verified |
  unverified | unavailable). **`PUT /v1/billing/company`** with any of
  those fields (absent = unchanged, null = cleared; `name` still accepted):
  the tax ID is checked by Stripe first (400 `invalid_tax_id` with
  Stripe's message, nothing changed) and replaces the others; name and
  address update the Customer (400 `invalid_company`); `po_reference`
  (≤ 100) becomes the Customer's invoice custom field `PO` on invoices
  finalized from then on; `billing_email` is stored (400 `invalid_email`)
  and copied (cc) on our receipt mails E1, E6, E13, since Stripe's API has
  no extra invoice recipients (on test the copy is only named in the mail
  to the owner). Every change is logged and kept on
  `customer.company.changes[{at, by: checkout|user, fields}]` (last 20).
  Admin `GET /v1/admin/accounts/{uid}` adds `company` (the same block) and
  `company_changes`. The older `POST /v1/billing/company/tax-ids {type,
  value}` and `DELETE /v1/billing/company/tax-ids/{txi_…}` stay.

### Web Pro on our own Stripe, and plan changes (owner 2026-11-04, test)

- **Pro plans**: product "Spatial Video Studio Pro" (test
  `prod_VZ4jvPAbtWTl2r`), prices `svs_web_pro_weekly` $5.99,
  `svs_web_pro_monthly` $8.99, `svs_web_pro_yearly` $79.99 (the App
  Store's). Intros as once-coupons: Weekly $3.99 × 4 weeks
  (`svs_pro_weekly_intro`, $2 off, on the Checkout's first invoice, then
  put on the next 3 cycles' draft invoices at `invoice.created`), Yearly
  $47.99 the first year (`svs_pro_yearly_intro`, $32 off); once per
  account (`customers.pro_intro_used`).
- **`/v1/pricing pro_plans[{id, interval, price_cents, intro{price_cents,
  cycles}|null}]`**.
- **`POST /v1/billing/plan {plan: pro_weekly|pro_monthly|pro_yearly|
  business|studio, ui}`**: the same Checkout; subscription metadata `plan:
  pro`, `plan_id`. The mirror reads `plan.tier: pro`, `plan.plan_id`;
  quotes price at Pro with the plan's free previews per period
  (allowance = plan id); `invoice.paid` grants RevenueCat "pro" alone to
  period end + 3 days; an early end revokes promotional "pro" and gives
  every other promotional grant back (see "Promotional Pro on refunds and
  disputes"). `GET /v1/billing` plan
  block adds `plan_id`, and for Pro `name`, `interval`, `price_cents`.
- **Plan changes** (order pro_weekly < pro_monthly < pro_yearly <
  business < studio; `pay_per_video`/`none` lowest):
  - `POST /v1/plans/preview-change {to}` → step-up `{kind: "step_up",
    from, to, today_cents, new_plan_cents, unused_credit_cents, renews_at,
    quote_at}`; step-down `{kind: "step_down", from, to, today_cents: 0,
    new_plan_cents, effective_at, quote_at}`.
  - `POST /v1/plans/change {to, confirm: true, quote_at?}` → `{change,
    plan}`; 400 `confirm_required`; 409 `quote_expired` (quote_at older
    than 15 min), `same_plan`, `change_scheduled`; 402 `payment_failed`
    (nothing changed). Business → Studio is a step-up like the others (a
    full Studio year from that day).
  - **Step-up**: now, a full new period from today on every step-up
    (`billing_cycle_anchor=now`, `proration_behavior=none`,
    `payment_behavior=error_if_incomplete`); today's charge = new price −
    `oldPlanCredit` = what the old period's plan line actually cost after
    discounts (an intro) × min(share of the period's time left, share of
    its usage left), rounded half up to the cent (usage: Business/Studio,
    plan credit left ÷ the month's credit; Pro, free previews left ÷ the
    period's allowance; unknown usage = time alone). A pending negative
    invoice item on the switch invoice, removed if the payment fails. The
    preview (`credit_basis {time_share, usage_share, paid_cents}`) and the
    change use the same quote at `quote_at`, so the preview equals the
    charge to the cent. The new plan's credit and free previews come in
    full that day; the old plan's leftover credit ends then (replace, not
    carry) and a Business entitlement is swapped for Studio's (pro kept).
  - **Step-down**: at the end of the paid period, a subscription schedule
    (phase 1 to `current_period_end`, phase 2 the new price with metadata
    `change_kind: step_down`, released after); → `pay_per_video`:
    `cancel_at_period_end`. No charge, no refund; the current plan's
    grants run to then; at the switch invoice the new plan's grants start
    and a Business/Studio entitlement it doesn't include is revoked.
  - `GET /v1/billing` plan block and `GET /v1/pro` (Pro plans): 
    `scheduled_change {to, effective_at}` or null. `DELETE
    /v1/plans/scheduled-change` takes it back ("Keep Studio").
- **`GET /v1/pro`** for a Pro plan on our Stripe: `pro: true, source:
  "plan", plan_id, free_previews` from the plan, `scheduled_change`; for
  App Store Pro, `management_url` is that subscription's own (RevenueCat
  `subscriptions[product].management_url`), else Apple's page.

**Runbook: the RevenueCat Web Billing Pro subscribers.** Two live people
still pay for Pro through RC Web Billing (no Stripe subscription; RC
charges each renewal itself). They stay there (no v2 key, no migration);
the gateway reads their Pro from RC (`source: rc_billing`). If either
steps up to Business/Studio: (a) in Stripe, create a one-off coupon worth
their unused days, based on what they actually paid (RC's
`subscriptions[product].price`, an intro included), and apply it to their
plan Checkout; then (b) in the RC dashboard, cancel the RC subscription
without a refund. Manual, two people.

### App Store Pro beside a plan (owner 2026-11-04)

No refunds or credits from us for an App Store Pro when someone buys
Business/Studio, only instructions.
- **`GET /v1/pro`** (and refresh) add `source` (`app_store` |
  `mac_app_store` | `rc_billing` | `promotional` | `plan` | `simulated`)
  and `management_url` (RevenueCat's `subscriber.management_url`, else
  `https://apps.apple.com/account/subscriptions` for Apple stores).
- **Plan receipt (E18)**, at the subscription's first paid invoice, once:
  "Spatial Video Studio: your Business plan has started"; with an active
  App Store Pro (found among all subscriptions, not hidden by the plan's
  entitlement) it adds "Your Pro is billed by Apple. Business includes
  everything Pro does, so cancel Pro in your iPhone's Settings → [your
  name] → Subscriptions to avoid paying for both." and the management
  link. `plan.started_at` is set then.
- **Reminder (E19)**, from the balance sweep, once per subscription,
  checked 3 days after `started_at`: only while the plan is active and
  not set to cancel, and the App Store Pro is active and still renews
  (no `unsubscribe_detected_at`): "Spatial Video Studio: cancel your App
  Store Pro to avoid paying twice". `plan.app_pro_checked` records the
  decision either way. On test, customer mails go to the owner's alert
  address with "(test)".

### Plans surfaces (owner 2026-11-04)

- **Events** (`POST /v1/events`): `plans_surface_view`,
  `plans_surface_dismiss`, `plans_surface_click` with `props {placement,
  variant?, plan?, quote_cents?, target?}`. `placement` is one of
  `header | projects_banner | quote | receipt | plans_sheet |
  business_note | business_banner | plans_hint`; `variant` and `plan` are
  ids (`[a-z0-9_.-]`, 60); `reason` an id of at most 32 (`source_8k |
  source_fps | quote_size | run_length | company_email`); `quote_cents` a
  whole number up to 100,000,000;
  `target` an id or a web path (`/plans#studio`, 80, never a URL). Other
  props are dropped; a bad value is 400. These three have 120 an hour per
  account of their own (the other events keep 30).
- **Attribution**: a start of Business or Studio (the plan's first paid
  invoice, once per subscription) or of Pro (`GET /v1/pro` or `POST
  /v1/pro/refresh` seeing Pro, without a web plan behind it, for someone
  it saw without Pro before; someone first seen with Pro isn't a start)
  is stored in `plan_conversions_{env}` with the last
  `plans_surface_click` of the 7 days before (`placement`, `variant`,
  `click_plan`, `click_at`; none = unattributed).
- **`GET /v1/admin/plans/surfaces?days=30`** (admin) → `{days,
  placements[{placement, views, viewers, dismissals, clicks, conversions,
  conversions_by_product {pro, business, studio}, by_reason[{placement,
  reason, views, viewers, dismissals, clicks, conversions,
  conversions_by_product, click_rate}] (reason "none" when absent),
  click_rate, conversion_rate}], unattributed {conversions, by_product},
  generated_at}`; every placement is listed; counts are events, viewers
  are people; `click_rate` = clicks ÷ views, `conversion_rate` =
  conversions ÷ clicks (4 decimals, 0 when the divisor is 0). BL-29 adds
  `starts[{uid, email, product, plan, source, price_cents, started_at,
  placement}]`, the window's plan starts newest first (at most 200; plan
  is the web plan id for a Checkout start; price_cents what its first
  period cost, null for an App Store start). `?days=7` is this week.
- **`/v1/account/settings` `dismissed`**: GET `{placement: RFC 3339}`
  (`{}` by default); PATCH `dismissed {placement: true (now) | time |
  null (clear)}`, placements as above, a future time clamped to now;
  `business_note` also per project as `business_note:<projectId>` (400
  unless it's the user's project). A PATCH that touches `dismissed`
  prunes per-project keys whose project is archived, deleted or gone,
  and keeps at most 200 keys (the newest).

### Alt prices and sales contact (owner 2026-11-04)

- **`alt_prices {pro, business, studio}`** (cents) on Lifelike quotes:
  the same run priced at each tier through the same quote (whole minutes,
  fps factor, Express/Master/foveation, analyze credit, rounding); free
  previews left out. Absent on Classic quotes (each would ask the
  pipeline about reuse again).
- **`POST /v1/contact {topic: business|studio|other, message, company?,
  team_size?}`** → `{sent: true}` (signed in): message 1–2000
  characters, company and team size (a number or text) 120 each. Stored
  in `contacts_{env}`; Slack `sales_contact` (topic, email, uid, plan,
  company, team, the first 500 characters); a mail to the owner's alert
  address (`OWNER_ALERT_EMAIL`, sergei@spatial-ai-labs.com) "Spatial
  Video Studio: business enquiry from <email>" (`(test)` on test, as the
  other test mails to the owner), reply-to the sender. Five a day per
  account (429 `rate_limited`).

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

**Tier order (studio > business > pro).** The account's tier is the
highest of: the web plan in the Stripe mirror (`cust.Plan`, the source of
truth for the plan and its credit) and what RevenueCat reports. RevenueCat
counts as a plan when the `studio` or `business` entitlement is active, or
when `pro` is reached through a plan product (TEST Stripe products
`prod_VYiOZAbAXiJP29` Studio, `prod_VYiOG5FegIJiFK` Business; other ids by
name). A plan found that way gets the plan's rate and free-preview
allowance (`business`/`studio`, never `pro_monthly`), without credit. A
Studio plan in the mirror skips the RevenueCat call.

**Plan entitlements in RevenueCat (owner decision: promotional grants, no
Stripe app).** On `invoice.paid` for a plan subscription (metadata
`product=svs-web`, our env) the gateway grants the uid the plan's
entitlement (`business` or `studio`) AND `pro` with `POST
/v1/subscribers/{uid}/entitlements/{id}/promotional {start_time_ms: now,
end_time_ms: period end + 3 days}` (if RevenueCat refuses the times, the
smallest `duration` that covers the end). It uses `RC_API_KEY_V1`, which
must be a secret key (`sk_…`; otherwise a logged no-op); the key is never
logged. One grant per invoice, recorded on the plan (`plan.rc_grant_invoice,
rc_granted_until, rc_grant_error`); retries on 5xx/429, then a Slack
`rc_grant_failed`; a failed grant never blocks the credit or the payment.
A normal end (cancel at period end, non-payment) needs nothing: the grant
runs out. An early end: the plan invoice refunded in full (a partial
refund only alerts Slack) revokes the plan's entitlement and its pro; a
dispute or an early fraud warning on it removes every promotional Pro;
the account blocked (A3) or deleted revokes the plan's entitlement only
(`plan.rc_revoked_at, rc_revoke_reason`). Other promotional grants are
snapshotted first and given back (next section). M3 re-grants an active
plan whose entitlement RevenueCat doesn't show (`plan_entitlement_missing`)
unless it was revoked. **Test accounts are real RevenueCat subscribers in
the one shared project: a grant on test gives that uid real app Pro until
its end time.**

**Promotional Pro on refunds and disputes (owner 2026-11-04).**
RevenueCat revokes all promotional grants of an entitlement at once, and
an account can hold grants we have no records of (support goodwill from
the RevenueCat dashboard; the SVS backend's free two weeks, which uses its
own `trial` entitlement). So before any revoke the gateway reads the
account's promotional grants from RevenueCat (`subscriptions` with store
`promotional`: entitlement, product, expiry) and stores the snapshot on
`promo_regrants_{env}/{event}` (event `refund:{invoice}` |
`dispute:{id}` | `efw:{id}` | `end:{subscription}:{reason}`) and on the
dispute case (`case.promo {record_id, snapshot, status}`).

- **Refund** (`revoke_ours`): the refunded purchase's entitlements are
  revoked, then every snapshotted grant except ours (our records: the
  plan's entitlements ending at `plan.rc_granted_until`, ±10 min) is
  granted again from now to its original end (lifetime stays lifetime);
  expired ones are skipped. RevenueCat shows one entry per product (the
  latest expiry), so another grant of the same product can hide under
  ours: when ours is the only `pro` entry the record gets `uncertain:
  true` and `promo_regrant_uncertain` is logged for support.
- **Dispute opened / early fraud warning** (`revoke_all`): every
  promotional grant of `pro`, `business`, `studio` and `trial` is removed
  and a yearly plan's months held back (`grants_paused`); Slack
  `promo_grants_removed` (account, amount, grants). A plan invoice paid
  meanwhile adds its grants to the hold instead of granting them. **Won**
  (also withdrawn, which Stripe reports as won, and a closed inquiry) or
  **clear_review** for a warning → everything in the snapshot back to its
  original end, expired skipped (`promo_grants_restored`); when another
  dispute or warning is still open, its hold takes the grants (`merged`).
  **Lost** → stays removed (`promo_grants_kept_removed`) until the owner
  runs admin action `restore_promo_grants` (fresh sign-in, `note` = the
  reason, audited) on the account.
- Every step is idempotent per event (a redelivered webhook does
  nothing). A failed snapshot, revoke or re-grant alerts Slack
  `promo_regrant_failed` and leaves the record in `snapshot_failed` |
  `revoke_failed` | `regrant_failed`; nightly M3 takes it up again
  (`promo_regrant_retry`). Statuses: `started`, `snapshotted`, `held`,
  `regranting`, `done`, `kept_removed`, `merged`, and the failures.
- A dispute on a plan invoice opens a manual dispute case like a run's
  (`related.pi_ids`, `dispute_id`, evidence, owner notice O1) with the
  snapshot on `case.promo`; its updates and close follow the run cases.
  The promo outcome is written before the case closes. An owner restore
  after a lost dispute appends one event to the closed case (kind
  `promo_restored`, `data {type, by, at, reason, restore_id,
  regranted[{entitlement, ends_at}], skipped[{entitlement, ends_at}]}`,
  in the admin case timeline `events`); the case stays closed and
  unchanged (`AppendClosedCaseEvent`, idempotent per restore id).

**Closed cases are locked (owner 2026-11-04).** `UpdateCase` refuses a
closed case, and `AddCaseEvent` on one takes only these system events
(`closedCaseEvents` in `store/cases.go`): `closed`, `refund_executed`,
`refund_failed`, `superseded`, `plan_ended`, `promo_restored`; anything
else is `ErrCaseClosed`. On a closed case the admin actions are:
`reopen {text: reason}` (audited; timeline `status_change` + `reopened
{previous_result}`), and `customer_reply {text}`, which never writes to
the closed case but opens (or reuses the open) follow-up case: type
`support`, reason `support_request`, `case.follow_up_of` = the closed
case, `related.linked_case_ids`, the message as `customer_message_in`,
the owner noticed (O1) as for any new case. Every other action (note,
decisions, close) is 409 `case_closed`; so is `adjust_balance` naming a
closed case. The case page shows `case.follow_up_ids[]` (read from the
follow-ups, never stored on the closed case) and `case.follow_up_of`.
- The rule for disputes sits in `disputePromoPolicy` (the owner may still
  change it).
- Admin `GET /v1/admin/accounts/{uid}` adds `promo_regrants` (the
  records, with snapshot, `ours`, `regranted`, `skipped`, `to_grant`,
  `uncertain`, `outcome`).

**Admin → Grant Pro (owner 2026-11-04).** **Runbook: never grant Pro
from the RevenueCat dashboard; use Admin → Grant Pro.** Dashboard grants
leave no record, and a refund or dispute can then only guess at them.

- `GET /v1/admin/accounts/{uid}/grants` → `{grants: [{id, uid,
  entitlement, ends_at, granted_by, reason, created_at, status: active |
  expired | revoked | failed | granting, rc_error?, revoked_at?,
  revoked_by?, revoke_reason?}]}`, newest first (also `grants` on the
  admin account view).
- `POST /v1/admin/accounts/{uid}/grants {entitlement: pro | business |
  studio, ends_at: RFC 3339 (1 h to 5 years ahead), reason (≤ 500)}`,
  fresh sign-in (401 `reauth_required`): the record on
  `promo_grants_{env}/{id}` first, then a RevenueCat promotional grant
  with `end_time_ms` = ends_at; audited and logged. 201 `{grant}`; 400
  invalid; 404 `no_account` (neither a web account nor an app user); 502
  `grant_failed {message, grant}` (record kept as `failed`); 503
  `rc_unavailable`.
- `DELETE /v1/admin/accounts/{uid}/grants/{id} {reason}`, fresh sign-in:
  the record is marked revoked, then the promo flow revokes the
  entitlement and gives every other grant back (`revoke:{id}`). 200
  `{grant, regrant {id, status, regranted, skipped}}`; 202 when the
  revoke or a re-grant failed (Slack, nightly retry); 404; 409
  `grant_not_active`.
- `GET /v1/admin/grants` (BL-29) → `{grants: [{id, uid, email, kind,
  granted_by, start, end, status, reason, revoked_at?, revoked_by?,
  revoke_reason?}]}`: every grant, active first, then newest (kind = the
  entitlement).
- Refund and dispute snapshots add every active admin grant of the
  revoked entitlements that RevenueCat's collapsed view doesn't show, so
  a support grant hidden under a plan's grant comes back with its own end
  (no longer `uncertain`).

**Plan credit when a plan ends early (owner rules 2026-11-03).** Each
freeze, unfreeze and removal is a balance ledger entry
(`plan_credit_freeze`, `plan_credit_unfreeze`, `plan_credit_removal`) with
a reason in `note`, a `ref` (`dispute:{id}`, `efw:{id}`, `block`,
`refund:{invoice}`, `deleted`) and the case when there is one; they show
in the balance history.

| Event | Plan credit | App entitlement |
|---|---|---|
| Cancel at period end, non-payment | unchanged until the period ends | runs out |
| Refund we grant (`plan_refund` case) | unspent credit removed at once; the refund is paid × unspent ÷ credit, rounded down (Business $299 with $200 of $400 left → $149.50); spent credit is never refunded; the subscription ends now | its business/studio and pro revoked, other promotional grants given back |
| Full refund from the Dashboard | removed | the same |
| Partial (goodwill) refund | kept, Slack alert | kept |
| Dispute on the plan invoice (or any payment of ours) | frozen; lost → removed; won → unfrozen (still expires at the period's end) | every promotional Pro removed; won → all back; lost → owner restore |
| Early fraud warning on it | frozen until **clear_review** | every promotional Pro removed until **clear_review** |
| Admin `block` / `unblock` | frozen / unfrozen | revoked on block |
| Admin `block_permanent` (fresh sign-in) | removed | revoked |
| Account deletion | removed, never paid out | revoked |

Credit an in-flight run's hold reserves stays for that run (it settles
from it); freezes and removals reach the unheld part. Frozen credit can't
fund new runs (it's out of `available`), so quotes fall through to the
rest of the balance or the card. A frozen part doesn't expire until it's
unfrozen or removed. **Plan refund case:** `POST /v1/admin/cases {uid,
reason: "plan_refund", text}` (or `svs-admin open -uid U -reason
plan_refund`) opens a manual case on the latest paid plan invoice
(`plan.last_invoice_id`, `last_credit_cents`); its one row is `{conversion_id:
plan_{invoice}, kind: plan, plan, paid_cents, credit_cents, unspent_cents,
refundable_cents, label}` and `max_refundable_cents` is the proposal;
`approve` refunds it, `partial` with `items {"plan_{invoice}": cents}`
less; the refund gets an amount-only credit note on the plan invoice.

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
projects ("Spatial Video Studio: files of N projects will be deleted on …"),
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
deploy.sh to the KPI-alert address) gets "Spatial Video Studio: N runs waiting
for a GPU": account email, method, step, resolution, length, waited so far,
busy GPUs per method vs `gpu_cap_per_app` (estimated from the runs in
progress at their worker caps), oldest wait. At most one mail per 15 min
per line; when the line empties, one "GPU line cleared" mail with the
longest wait. The throttle lives in `ops_{env}/gpu_line`, so instances
agree. No address or no Resend key → logged only.

### Get another format (ADR 0137)

A finished Lifelike run's stored output is re-packed into a format it
doesn't have by the Lifelike service (it encodes like the pipeline);
Classic runs get none (Classic is retired).

- `GET /v1/runs/{id}/formats` → `{available: [fmt], have: [fmt],
  pending: [fmt], unavailable_reason?: files_erased | half_only |
  run_failed | classic_retired, price_cents: 0, jobs:
  {fmt: {job_id, job_ids, status: pending | processing | succeeded |
  failed, source, price_cents, estimated_seconds, requested_at,
  finished_at, error?, parts:
  [{index, name, job_id, status, error?}]}}}`. `job_id` is the first
  part's; `index` 0 is a run's single file. fmt is
  mvhevc | sbs | half_sbs. The GET also polls a running repack.
- `POST /v1/runs/{id}/formats {format}` → 202 `{job_id, job_ids, status,
  format, source, price_cents, estimated_seconds}`. `estimated_seconds`
  (3DS, 2026-11-04): side-by-side ≈ 2× the run's length, spatial ≈ 10×
  at 4K, scaled by the preset's pixels against 4K, plus 30 s per file
  (each split part starts its own container); the whole run's
  length, so a split run's parts often finish sooner. 409 `format_exists` | `format_in_progress` |
  `format_unavailable` with `details.reason` (the reasons above, or
  `too_wide`: full side-by-side at 6K/8K); 422 `sample_project` for the
  sample's run (it has all three: spatial, full and half side-by-side,
  owner 2026-11-04; runs stored with two are backfilled from
  `sampleFiles` when read or listed); 400 unknown format; 429
  `rate_limited` (10 an hour per account); 502/503 `repack_unavailable`
  (the Lifelike service didn't take it; the attempt is recorded as
  failed and can be retried).
- **Rules.** Only a succeeded run whose project isn't deleted and whose
  files aren't erased (`file_keep_days`). The
  source depends on the target (`repackSources`): half side-by-side from
  spatial, else full side-by-side (full side-by-side files made before
  2026-11-04 carry a slight colour shift); spatial only from full
  side-by-side; full side-by-side only from spatial; half side-by-side alone can't make
  a fuller format. One per format per run; a failed one can be retried.
  A split run gets one repack per part (`mvhevc_part2` →
  `half_sbs_part2`); the format is done when every part is, failed when
  none is running and one failed, and a retry repacks only the failed
  parts (the made ones stay).
  Free for now (`price_cents: 0`, ADR 0137's open question). Starting one
  counts as use of the project (the keep clock restarts).
- **Lifelike call.** `POST /repack {job_id, source: {url: signed GET of
  the stored output, format}, target_format, output_upload_url: signed
  PUT of outputs/<job>/repack_<output>.mp4|.mov, preset, fps,
  output_bitrate_bps?}` (the run's own bitrate when it chose one: Master
  or an explicit rate; absent otherwise) →
  `{repack_id}`; `GET /repack/{id}` → `{status: queued | running | done |
  failed (completed = done; error, cancelled = failed), output: {bytes,
  width, height, frames, level}, cost_stage}`, polled by the reconciler every
  minute (`conversion.repack_pending`) and by the GET; 3 h without an end
  fails it (spatial: max(3 h, 2× its estimate)). Signed URLs live 6 h.
- **Then.** The new files join `conversion.outputs` (`format`, or
  `format_partN` per part, all at once when the last part is done), so
  they list and download like the others (same naming, SBS/TB markers).
  `conversion.repacks[format]` keeps the record; events
  `run_format_requested`, `run_format_added`, `run_format_failed`; the
  admin case page's run rows and the account view's runs show
  `formats_added`.

### Customer passkeys (ADR 0136)

An extra way to sign in to an existing account (made with Apple, Google
or email first), with the admin WebAuthn code but its own relying party
and store.

- **Relying party.** RP ID `stereo3d.studio` for `https://stereo3d.studio`,
  `https://www.stereo3d.studio` and `https://staging.stereo3d.studio`; on
  test also RP `localhost` for `http://localhost:3000` (the web's dev
  server; a localhost page can't use the stereo3d.studio RP ID). User
  verification required, discoverable credentials (usernameless
  sign-in), attestation none, 5-minute single-use challenges bound to
  the purpose, origin and (for adding) the account.
- **Storage.** `customer_passkeys_{env}/{credId}` {uid, name,
  device_hint, public_key, sign_count, aaguid, transports, rp_id,
  created_at, last_used_at, credential}; test and prod apart, so a
  staging passkey offered on www is `passkey_not_registered` there.
  `customer_passkey_challenges_{env}`.
- **Routes.**
  - `POST /v1/account/passkeys/register/options {name?}` (signed in) →
    `{options: {publicKey}, expires_at}`; the ID token's auth_time must be
    within 5 minutes, else 401 `reauth_required {method: "firebase"}`.
  - `POST /v1/account/passkeys/register/verify {response, name?}` (signed in, the
    same rule) → 201 `{passkey: {id, name, device_hint, created_at,
    last_used_at}}`; the name defaults to the device hint (the
    authenticator by AAGUID, else browser and system from the user agent,
    such as "Safari on iPhone"). 400 `challenge_invalid` |
    `passkey_invalid`; 409 `passkey_exists`.
  - `POST /v1/auth/passkey/options` (no sign-in) → `{options:
    {publicKey}, expires_at}`, no allowCredentials, so it also serves
    autofill (the web sets mediation "conditional").
  - `POST /v1/auth/passkey/verify {response}` (no sign-in) →
    `{uid, custom_token}` for `signInWithCustomToken`. 404
    `passkey_not_registered` ("This passkey isn't registered here"); 401
    `passkey_invalid`, `passkey_clone_suspected` (the sign count went
    backwards: logged, Slack, refused); 403 `account_unavailable`
    (deleted or blocked); 502 `sign_in_unavailable` (token not minted).
  - `GET /v1/account/passkeys` → `{passkeys: [{id, name, device_hint,
    created_at, last_used_at}]}`; `PATCH /v1/account/passkeys/{id} {name}`
    → `{passkey}`; `DELETE /v1/account/passkeys/{id}` → `{removed}` (404
    for another account's).
  - The "Add a passkey" suggestion is dismissed through `/v1/account/settings`
    with `dismissed.passkey_suggestion` (an accepted key); the web shows
    it while the account has no passkey and hasn't dismissed it.
  - All 429 `rate_limited` past 60 an hour per IP, and adding or signing
    in past 20 an hour per account (per instance).
- **Around them.** Events `passkey_added`, `passkey_removed`,
  `passkey_renamed` and `sign_in
  {method: "passkey"}`; the web logs its other sign-ins as `POST
  /v1/events {name: "sign_in", props: {method: google | apple | email |
  password | email_code}}`. A plain security mail (S1 added, S2 removed;
  the subject names Spatial Video Studio; on test it goes to the owner's
  alert address only). Account deletion removes the account's passkeys.
- **Admin.** `GET /v1/admin/passkey-adoption` → `{accounts_with_passkey,
  passkeys, sign_ins: {"7d": {method: count}, "30d": {…}},
  generated_at}`; the admin account view adds `passkey_count`.

### Admin passkeys (ADR 0135)

The admin console's only second factor is a passkey (WebAuthn,
go-webauthn). Owner 2026-11-04: no authenticator codes, and the project
never moves to Identity Platform.

- **Relying parties.** Prod `admin.stereo3d.studio` (origin
  `https://admin.stereo3d.studio`); test `admin-test.stereo3d.studio`
  (`https://admin-test.stereo3d.studio`) and `localhost`
  (`http://localhost:5174`). Each accepts its own origin only (also
  narrowed by `ADMIN_ORIGINS`). userVerification required, residentKey
  preferred, attestation none.
- **Storage.** `admin_passkeys_{env}/{credId}` {uid, name, public_key,
  sign_count, aaguid, transports, rp_id, created_at, last_used_at,
  credential}; challenges `admin_passkey_challenges_{env}/{challenge}`
  (single use, 5 minutes, bound to uid, purpose register | session and
  origin); `admin_session_epochs_{env}/{uid}`.
- **Routes** (all: Firebase ID token with `svs_admin`, an admin origin;
  the passkey routes don't need the second factor themselves):
  - `POST /v1/admin/passkeys/register/options {name?}` → `{options:
    {publicKey: PublicKeyCredentialCreationOptions}, expires_at}`. The
    first passkey of a uid needs the token's auth_time within 5 minutes
    (else 401 `reauth_required {method: "google"}`); a further one also
    needs `X-Admin-Session` with an assertion within 5 minutes (401
    `reauth_required {method: "passkey"}`).
  - `POST /v1/admin/passkeys/register/verify {name?, response}` (the
    `PublicKeyCredential` JSON) → 201 `{passkey: {id, name, created_at,
    last_used_at}}`; 400 `challenge_invalid` | `passkey_invalid`; 409
    `passkey_exists`. Slack `admin_passkey_added` (uid, name, origin,
    country).
  - `POST /v1/admin/session/options {purpose?: sign_in | reassert}` →
    `{options: {publicKey: PublicKeyCredentialRequestOptions},
    expires_at}`; 409 `no_passkey`; reassert without a session 401
    `session_required`. The challenge is bound to the purpose.
  - `POST /v1/admin/session/verify {purpose?, response}` → `{session,
    expires_at, last_assertion_at}`: sign_in starts a session, reassert
    (with `X-Admin-Session`) returns the same session (sid, exp) with
    `last_assertion_at` now. The session is HMAC-SHA256 signed with
    `ADMIN_SESSION_KEY` (Secret Manager `admin-session-key-{env}`, mounted
    by deploy.sh when it exists): claims uid, iat, exp (12 h),
    last_assertion_at, the uid's epoch. The console sends it as
    `X-Admin-Session`. 401 `passkey_invalid` (bad signature, wrong origin
    or RP, used meanwhile), `passkey_clone_suspected` (the sign count
    didn't go up; Slack), 400 `challenge_invalid` (replayed, expired, or
    another purpose's or account's).
  - `GET /v1/admin/passkeys` → `{passkeys: [{id, name, created_at,
    last_used_at}]}`.
  - `DELETE /v1/admin/passkeys/{id}`: an assertion within 5 minutes; 409
    `last_passkey`; Slack `admin_passkey_removed`.
- **Admin auth.** Every other admin route takes the token with a valid
  `X-Admin-Session` for the same uid, nothing else. A session header that
  doesn't verify is 401 `session_expired` or `invalid_session` (bad
  signature, another account's, revoked by a reset), with `{method:
  "passkey"}`; no session is 401 `session_required {methods:
  ["passkey"]}`. The console drops its token on all three. Money actions
  need the last assertion within 5 minutes, else 401 `reauth_required
  {method: "passkey"}`; svs-admin, run locally with the operator's own
  credentials, isn't asked.
- **Break-glass.** `gateway/scripts/admin-passkeys-reset.sh <test|prod>
  <uid> [--dry-run]`, run locally with your gcloud login: deletes that
  uid's passkeys and pending challenges, bumps its session epoch (every
  session ends), prints only the counts and posts Slack
  `admin_passkeys_reset` (uid, who ran it). The admin then signs in with
  Google and enrols a first passkey within 5 minutes.

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
Firebase ID token with custom claim `svs_admin: true` and a passkey
admin session (`X-Admin-Session`, see "Admin passkeys (ADR 0135)").
Errors: 403 `origin_not_allowed`, 401 `invalid_token`, 403 `no_access`,
401 `session_required` | `session_expired` | `invalid_session`; money
actions need a passkey assertion within 5 minutes (401 `reauth_required
{method: "passkey"}`). Every call is audited in `admin_audit_{env}`;
responses are `no-store`.

| route | |
|---|---|
| `GET /v1/admin/cases?tab=open\|waiting\|decided\|closed\|all&type=&reason=&mode=&cap=over\|under&q=` | `{cases:[{id,uid,type,reason,mode,status,result,opened_at,age_hours,email_masked,message_excerpt (the customer's first message, one line, ~280 characters, or null),run_ids[],requested_cents,max_refundable_cents,deadline_at,deadline_red,dispute_due,last_activity_at}], counts:{open,overdue,due_today}}`; disputes first, then EFW/refund_failed, then oldest |
| `POST /v1/admin/cases` `{uid, conversion_ids, reason, text, topup_id}` | opens cases (balance reasons need `topup_id` for withdrawals) → `{cases:[page]}` |
| `GET /v1/admin/cases/{id}` | page: `{case, runs, max_refundable_cents, events, evidence, related_cases, hints, banners, account, refunds, actions}` |
| `POST /v1/admin/cases/{id}/actions` `{action, items, expected_max_cents, template, text, method, reference}` | actions `note, customer_reply, refresh_evidence, ask, approve, partial, waive, deny, no_refund, mark_out_of_band, assign, stop_run, accept_dispute, counter_dispute, counter_with_refund_proof, close` (`accept_dispute` closes the dispute in Stripe and the webhook closes the case; counters are filed in the Stripe Dashboard and recorded here); 409 `action_unavailable`, 409 `amount_changed` when the maximum moved → the page |
| `GET /v1/admin/accounts?q=` | BL-29 ⌘K: `{accounts:[{uid,email,created_at,plan}]}`; an exact uid first, then emails starting with q (any case), at most 20; q 2–320 characters, never logged (the audit row holds the result count) |
| `GET /v1/admin/runs/{id}` | BL-29: `{run:{id,uid,project_id,status,created_at,amount_cents,currency,kind,method}}` (status = the run's state); 404 `run_not_found` |
| `GET /v1/admin/efws` | BL-29: `{efws:[{id,uid,charge,payment_intent,amount_cents,created,case_id}]}`: every open early fraud warning, with an open efw case or only a fraud-warning promo hold (case_id null), newest first; charge and created from Stripe when it answers |
| `GET /v1/admin/accounts/{uid}` | `{account:{uid,email,deleted,stripe_customer_id,sheet_only,sheet_only_reason,under_review,blocked,owed_cents,lifetime_paid_cents,plan,balance,…}}` |
| (BL-29 additions) | `account.created_at`; `runs {count, items[{id,project_id,status,kind,created_at,amount_cents}], next_before}` (newest first; `?runs_limit=1..100` (20), `?runs_before=<next_before>`); `usage {period: plan\|month, period_start, period_end, tier, runs, succeeded, spent_cents, free_preview_runs, free_previews{allowance,used,remaining,…}, plan_credit_cents?, plan_credit_left_cents?, plan_credit_used_cents?}`; `sign_in {methods[google\|apple\|password\|phone\|…\|passkey], passkey_count, firebase_created_at, last_sign_in_at}` (from Firebase Authentication; methods null when it can't be read) |
| `POST /v1/admin/accounts/{uid}/actions` `{action, cents, case_id, note}` | `clear_review, clear_sheet_only, block, unblock, block_permanent, resend_e2, write_off_owed, adjust_balance` (needs `case_id`); `block` → 403 `account_blocked` on new runs |
| `GET /v1/admin/disputes/summary?months=1..24&format=csv` | A4: `{months:[{month,charges,disputes_activity,disputed_cents_activity,disputes_by_payment,activity_pct,won,lost,accepted,countered,lost_cents,won_cents,dispute_fees_cents,efw,efw_cents,efw_refunded,efw_became_disputes}], reference_pct, win_rate, won_cents, lost_cents (window totals; won = recovered), counter_rate, open, open_efws (open efw cases + caseless fraud-warning holds), by_method, by_flow, by_country, scope, account_wide, denominator, generated_at}` |
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
