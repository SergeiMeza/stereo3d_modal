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
  `inpaint`, `depth_res`, `target_fps`, `from_frame`/`to_frame`. Same
  validation rules as the pro steps (`backward` ⇒ `inpaint: none`,
  `migan` ⇒ forward warp).
- **Params (image)**: `displacement`, `stereo_mode`, `warp`, `inpaint`
  (§2), `formats`, `output_depthmap`.
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
UTC day**, then `image_cents` (50¢) applies. Applies to all clients (the
web has no stills UI, so blast radius ≈ 0). The cap is Firestore-tunable
(`free_images_per_day`); remaining allowance is in the §5 response as
`usage.free_images_remaining`, and a priced still past the cap still
requires a card on file. Submitting still counts against
`max_active_per_user`.

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
- **Batched billing (web first, 2026-09-02)**: the web now groups cheap
  successful steps into one charge per account (4 h window or a tiered
  cap; see gateway/DESIGN.md). Mobile one-shot conversions still charge
  per conversion until the server flag `batch_one_shot` is switched on.
  When it is, a succeeded conversion reports
  `billing.status = "batched"` (+ `batch_id`) instead of `"charged"`,
  `/v1/limits.billing.pending_cents` carries the running balance, and
  `POST /v1/billing/pay-now` charges it immediately — build for both
  statuses now so the flip needs no app release.
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
  "usage": { "active_conversions": 1, "free_images_remaining": 97 },
  "billing": { "has_payment_method": true, "delinquent": false, "unpaid_cents": 0,
               "pending_cents": 0, "tier": { "cap_cents": 5000, "window_hours": 4,
                                             "hold_threshold_cents": 10000, ... } },
  "rates": { "cents_per_minute": {...}, "image_cents": 50, "minimum_cents": 50,
             "cost_margin_multiplier": 3, "inpaint_multiplier": 1.6,
             "migan_production_multiplier": 0.5, "production_no_inpaint_multiplier": 0.4,
             "hold_threshold_cents": 10000, "rate_version": "..." }
}
```

Pre-upload price: show a **local estimate from `rates`, labeled as an
estimate**; the authoritative quote is still the server's at submit.
That is the supported pattern.

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
