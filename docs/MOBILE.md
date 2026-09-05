# Mobile (iOS/macOS/visionOS) backend contract — answers + plan

Status: **decision sheet, agreed 2026-09-01** — answers to the mobile
agent's brief, with the backend work it implies. Sections marked SHIPPED
flip as the work lands. No backward compatibility with the retired
direct-Modal endpoints or the old `paymentsAPI` stack: the new app
versions build against exactly what is written here.

## §7 first — the endpoint decision everything hangs on

**Use the one-shot flow: `POST /v1/uploads` → `POST /v1/conversions` →
poll `GET /v1/conversions/{id}` → `GET /v1/conversions/{id}/downloads`.**
The pro project pipeline stays a web feature (scene editing, per-shot
overrides, artifact reuse across steps); mobile gets none of that
complexity and none of its constraints (e.g. the analyze step, scenes
versioning).

`POST /v1/conversions` is reworked (**SHIPPED**, no back-compat) to:

- **Billing**: the web model — card saved once via SetupIntent, then the
  threshold hybrid: quotes ≥ `hold_threshold_cents` ($100) place an
  off-session hold, everything below charges the saved card **on
  success**. The response no longer carries PaymentSheet material; a 402
  with `no_payment_method` / `billing_overdue` routes the app to §4.
- **Params (video)**: `preset`, `formats`, `depth_model` (§1), `warp`,
  `inpaint`, `depth_res`, `target_fps`, `from_frame`/`to_frame`,
  `displacement`, `placement`. Same validation rules as the pro steps
  (`backward` ⇒ `inpaint: none`, `migan` ⇒ forward warp).
- **Params (image)**: `displacement`, `placement`, `stereo_mode`, `warp`,
  `inpaint` (§2), `formats`, `output_depthmap`.
- **Stereo strength (video + image, added 2026-09-05)**: `displacement`
  is the total parallax budget as a fraction of frame width, (0, 0.03];
  backend default 0.0125 for video, 0.01 for photos when omitted.
  `placement: [far, near]` positions the scene against the screen plane
  as fractions of that budget (far ≤ 0 behind the screen, near > 0
  pop-out); both in [−1.5, 1.5] with far < near; omitted = `[-1.0, 0.5]`.
  Same mapping as the app's on-device kernel: signed disparity =
  displacement × (depth × (near − far) + far), halved per eye in dual-eye
  mode. Send the on-device values so cloud output matches the preview.
  Rejected with 400 `invalid_request` when malformed.
- `formats: ["mvhevc"]` alone is supported and skips the SBS deliverable
  encodes — confirmed. **Video only**: stills have no spatial-photo
  output yet, so `mvhevc` on an image 400s.
- **Image formats** (fixed 2026-09-02, was the first mobile-still
  failure): allowlist `sbs | half_sbs | tb | half_tb | anaglyph`;
  omitted ⇒ `["sbs"]`. Still downloads are keyed
  `<stem>/<format>` (the upload is stored as `source.jpg`, so
  `source/sbs`, …) plus always `source/left` + `source/right`, and
  `source/depth` unless `output_depthmap: false`.

## §1 DA2 on video — yes, shipping it

**SHIPPED.** `depth_model: "da2"` joins the allowlist: per-frame relative
Depth-Anything-V2-Large through the existing frame-depth worker (the
same `transformers` loader the dormant `da2-metric-*` variants use, with
the standard relative checkpoint), normalized per scene like the other
relative models. One correctness detail handled backend-side: relative
DA2 outputs *disparity* (near = large) where DA3 outputs *depth*, so
`da2` skips the inversion step — worth knowing because getting it wrong
produces plausible-looking inverted stereo.

Product note (corrected 2026-09-01): `da2` is not just the parity
choice, it is the CHEAP one — VDA's 32-frame temporal windows cost well
over an order of magnitude more GPU time than a per-frame DA2 pass at
the same `depth_res` (developer-measured >10×). The trade is temporal
stability (per-frame depth can breathe across frames; per-scene
normalization + frame-to-frame affine alignment contain but don't
eliminate it). `vda` stays available on the same parameter whenever
mobile wants the premium option — no app-side migration beyond the
string.

## §2 warp + inpainting

- `warp: backward` / `forward` on video: **SHIPPED** (backward runs on
  the cheap L4 tier).
- `inpaint: migan` on video: **SHIPPED**.
- `warp` on images: **SHIPPED + staging-tested** (backward, migan and
  lama stills all verified end-to-end on the staging pipeline,
  2026-09-01).
- `inpaint` on images: **SHIPPED** — `"lama"` (default, today's
  behavior) | `"migan"` | `"none"` (raw splat) | implicit none with `backward`. MI-GAN runs
  per-still exactly like the app's local path, so cloud and local stills
  match.
- Confirmed: never send `warp: backward` with an inpaint model — the
  gateway 400s the contradiction by design.

## §3 free photos — free with a daily cap

**SHIPPED.** Image conversions are **free up to 100 stills per user per
UTC day** (`free_images_per_day`, Firestore-tunable; remaining allowance
in §5 as `usage.free_images_remaining`). Submitting still counts against
`max_active_per_user`.

**Paid photos are metered and batched (SHIPPED 2026-09-02; photo packs
withdrawn the same day).** Past the free allowance a still is billed
exactly like a video: quoted at `rates.image_cents` (**5**,
Firestore-tunable; never hardcode), charged **after the fact** through
the account's open batch (§4). Prepaid credits consumed in-app are a
consumable IAP under App Review Guideline 3.1.1, which is why the packs
went away; metered pay-after billing is the model that has already
passed review.

- Ordering at image create: free daily allowance first
  (`amount_cents: 0`, `breakdown.free_image: true`), then any leftover
  pack credit (`breakdown.photo_credit: true`, `amount_cents: 0`,
  refunded if the run never delivers), else a **paid still**:
  `quote.amount_cents = image_cents`, `breakdown.free_image: false`,
  card required (402 `no_payment_method`), refused while a batch charge
  is outstanding (402 `billing_overdue`), and on success it joins the
  open batch (`billing.status: "batched"`, `batch_id`; the batch item
  carries `kind: "image"`). A failed or canceled paid still is simply
  not billed. The up-front hold path never applies to a still (5¢ is
  far under `hold_threshold_cents`).
- **Small tabs roll over.** A batch whose total is under
  `rates.minimum_cents` (50) when its window elapses — a few paid stills
  and nothing else — is not charged; its `due_at` moves out another
  window and it collects with the next conversions. `pay-now` on such a
  batch returns **400 `below_minimum_charge`** with
  `details: {amount_cents, minimum_cents}`.
- **Photo packs are withdrawn.** `POST /v1/billing/photo-pack` returns
  **410 `photo_packs_withdrawn`**; `rates.photo_pack` is gone from
  `/v1/limits` and `/v1/billing`; 402 `no_photo_credits` is never
  emitted. `usage.photo_credits` / `billing.photo_credits` appear only
  while a leftover balance exists (nobody bought one through the app;
  purely defensive) and are spent before a still is charged.
- Estimate line (the supported pattern): "97 free today · 3 more at
  $0.05 each, charged with your other conversions."

## §4 payments for a native Stripe client

- **SetupIntent**: `POST /v1/billing/setup-intent` is client-agnostic —
  it returns the SetupIntent `client_secret` plus customer + ephemeral
  key material; drive it with `PaymentSheet` in setup mode (or
  `STPSetupIntentConfirmParams`). No return-URL or redirect assumption
  exists server-side for card payment methods. (If the response shape is
  missing anything PaymentSheet-setup needs, that's a bug to file, not a
  design gap — being verified as part of this work.)
- **3DS, native story**: two places a challenge can appear, both carry a
  `client_secret` the iOS SDK handles with `STPPaymentHandler`:
  1. a ≥$100 hold that demands 3DS parks the conversion at `created`
     with `billing.status = "requires_action"` + `client_secret` +
     `publishable_key` in the conversion response → call
     `STPPaymentHandler.handleNextAction(forPayment:)`, then keep
     polling; the webhook flips it to `paid`.
  2. a failed post-success charge → `POST /v1/billing/settle` returns
     `requires_action` + `client_secret` → same handler. Nothing here is
     web-only; `confirmCardPayment` and `STPPaymentHandler` are the same
     Stripe API surface.
- **Threshold**: yes, intended — mobile jobs under $100 skip the hold
  and charge on success. Not an accident; it's the design (banks decline
  many small pre-auths, and failed charges gate future work + downloads:
  a succeeded conversion whose charge failed 402s on
  `/downloads` until settled).
- **Batched billing (SHIPPED for mobile 2026-09-02, same system as
  the web)**: successful conversions below the hold threshold are no
  longer charged one by one. They join the ACCOUNT's open batch (shared
  with the user's web steps) and are charged as ONE payment when the
  batch window elapses (4 h), the total reaches the account's tier cap,
  or the user pays now. Tier caps grow with lifetime collected spend:
  $50 → $150 (after $200) → $400 (after $1,000) → $1,000 (after
  $5,000); the hold threshold is `max($100, cap)`, so read it from
  `/v1/limits` rather than assuming $100. Contract:
  - a succeeded conversion reports `billing.status = "batched"` +
    `batch_id` (later `"charged"` once the batch settles, or
    `"charge_failed"` if the batch's card charge is declined — same
    402/settle handling as before);
  - `GET /v1/limits.billing` carries `pending_cents` and `tier`
    (`cap_cents`, `window_hours`, `lifetime_paid_cents`,
    `hold_threshold_cents`, optional `next_tier {min_paid_cents,
    cap_cents}`);
  - `GET /v1/billing` carries the full open batch as `pending`
    (`batch_id, amount_cents, currency, cap_cents, opened_at, due_at,
    items[{conversion_id, kind, description, amount_cents, added_at}]`)
    and the same `tier`; a failed batch appears in `unpaid[]` with
    `batch_id` + `items` (legacy entries keep `conversion_id`);
  - `POST /v1/billing/pay-now` charges the open batch immediately —
    returns `{settled}` or `requires_action + client_secret`
    (STPPaymentHandler) or `message` on decline, exactly like `settle`.
  - Free stills never enter a batch; paid stills (§3) do, at
    `image_cents` each. `/downloads` stays available while the batch is
    open or charging (locked only after a decline).
- **`POST /v1/customers`**: skip it. `setup-intent` (and every billing
  route) ensures the Stripe customer implicitly. The endpoint stays for
  the web but is not part of the mobile contract.

## §5 `GET /v1/limits` — pre-upload limits/usage/rates

**SHIPPED.** New authed endpoint, one call, no project needed:

```jsonc
{
  "limits": {
    "max_duration_s": 1800, "max_source_bytes": 8589934592,
    "max_active_per_user": 3,
    "max_width": 7680, "max_height": 4320,   // hard reject above (§6)
    "normalize_height": 2160,                 // above this we downscale, not reject
    "max_fps": 120                            // hard reject above; >60 auto-decimated
  },
  "usage": { "active_conversions": 1, "free_images_remaining": 97 }, // + photo_credits only while a leftover pack balance exists
  "billing": { "has_payment_method": true, "delinquent": false, "unpaid_cents": 0,
               "pending_cents": 0, "tier": { "cap_cents": 5000, "window_hours": 4,
                                             "hold_threshold_cents": 10000, ... } },
  "rates": { "cents_per_minute": {...},
             "image_cents": 5,             // per paid still past the free allowance, batched (§3)
             "minimum_cents": 50,          // smallest card charge; smaller batches roll over
             "min_billable_seconds": 60,   // one-shot video floor: clips shorter than
                                           // this are priced as this long (2026-09-02)
             "cost_margin_multiplier": 3, "inpaint_multiplier": 1.6,
             "migan_production_multiplier": 0.5, "production_no_inpaint_multiplier": 0.4,
             "hold_threshold_cents": 10000, "rate_version": "..." }
}
```

Pre-upload price: show a **local estimate from `rates`, labeled as an
estimate**; the authoritative quote is still the server's at submit.
That is the supported pattern. The one-shot video formula (mirror it for
the estimate): `billed_s = max(duration_s, min_billable_seconds)`;
`base = billed_s / 60 × cents_per_minute[preset] × cost_margin_multiplier
× clamp(fps / 24, 0.5, 2.5)`; then a depth-resolution adjustment on 35%
of the base (1× at 1080p on 16:9), the mode multiplier
(`inpaint: none` ×`production_no_inpaint_multiplier`, `migan`
×`migan_production_multiplier`, `propainter` ×1), 10% off over $10, and
`minimum_cents`. The quote's `breakdown` echoes every factor
(`billable_seconds` actual, `billed_seconds` after the floor).

## §6 resolution / fps

Philosophy: **normalize, don't reject** — the pipeline already downscales
every input to the preset's output height and can decimate fps, so an
oversized clip is a cost problem the quote already prices, not an error.
Server-enforced rails (published via §5):

- Hard reject only above 8K (7680×4320) and above 120 fps — genuine
  crash/timeout territory.
- Inputs above the preset resolution: downscaled (existing behavior).
- Sources over 60 fps with no explicit `target_fps`: auto-decimated to
  ≤60 (halving), reported in the conversion's `params` so the app can
  tell the user.

## Backend work list (priority order)

1. `da2` on video (Modal) + `depth_model` through `/v1/conversions` and
   the gateway params. — §1
2. `/v1/conversions` rework: auto-billing, new param surface, image
   params plumbed to Modal (today the image branch forwards only
   `formats` + `displacement`). — §7, §4
3. `GET /v1/limits` + the §6 rails. — §5, §6
4. Free-stills daily quota + `inpaint: migan|lama` on the image
   pipeline. — §3, §2
5. Staging e2e for image backward/migan paths; SetupIntent response
   verified against PaymentSheet-setup field needs.

## What the app should NOT rely on

- Anything under `/v1/projects` — web contract, may change without
  regard for mobile.
- Undocumented Modal endpoints — the gateway is the only public surface;
  prod Modal requires proxy auth precisely so this stays true.
- Download URLs beyond their `expires_in` — re-fetch `/downloads`.
- Downloads for a conversion whose charge failed — 402 until settled.
