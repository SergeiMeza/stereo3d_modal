# Web streaming on Modal, metered — design (2026-09-08)

Status: proposed. Companion to the Apple app's ADR 0024 (streaming from
outside the home over a forwarded port, the *Anywhere* tier).

## What we are building

A user opens a page in the headset's browser, pastes a URL (a video
file, an HLS or RTMP/RTSP stream), and watches it in 3D or as spatial
video while a Modal GPU converts it. Nothing is installed, no Mac has
to be on. The Anywhere subscription includes a monthly allowance of
streamed minutes; beyond it, streaming is pay as you go on the card on
file, through the existing batch billing.

The Apple app's Play Live does the same thing on the user's own Mac.
The web version is for users without a Mac, away from home, or who
want the heavier server models.

## Decisions

### 1. One entitlement, RevenueCat as the hub

The Apple app already logs RevenueCat in with the Firebase uid
(`AppDelegate.swift:157`), so the RevenueCat *app user id* **is** the
gateway's uid. The gateway learns entitlements two ways:

- **Webhook** `POST /webhooks/revenuecat` (Authorization header shared
  secret), writing `entitlements.{pro,remote}` = `{active, expires_at,
  store, product_id}` onto `customers_{env}/{uid}`.
- **Pull on miss**: `GET https://api.revenuecat.com/v1/subscribers/{uid}`
  with the secret key when the customer doc has no entitlement block
  (first web visit of an app subscriber), cached 10 minutes.

Web-only users subscribe through **RevenueCat Web Billing** (Stripe
under the hood, no Apple cut), which lands in the same webhook. The
Anywhere product exists once per store; RevenueCat merges them under
the `remote` entitlement. No second subscription system, no Stripe
Subscriptions in the gateway.

Rejected: a Stripe Subscription managed by the gateway. It would mean a
second source of truth for the same entitlement and its own webhook,
renewal and grace logic, all of which RevenueCat already does.

### 2. Minutes are the unit; bandwidth is a cost we design out

The user asked whether bandwidth must be billed too. With the current
setup, yes: outputs are served straight from GCS at ≈$0.12/GiB, and a
stream is bandwidth-heavy.

| Stream | Bit rate | Egress per hour | GCS egress cost per hour |
|---|---|---|---|
| 1080p side by side (H.264) | 8 Mbit/s | 3.6 GB | ≈ $0.43 |
| 1440p side by side | 12 Mbit/s | 5.4 GB | ≈ $0.65 |
| 4K spatial (MV-HEVC) | 14 Mbit/s | 6.3 GB | ≈ $0.76 |

That rivals the GPU (L4 ≈ $0.80/h, L40S ≈ $1.95/h). Two ways out:

- **Bill it**: meter bytes per session behind Cloud CDN (signed cookies,
  log sink to a ledger) and add `cents_per_gib`. Customers then see
  two meters they cannot predict.
- **Remove it**: serve segments from **Cloudflare R2** (zero egress,
  $0.015/GB‑month) through a Worker that also counts bytes per
  session. Egress stops being a cost, the per-minute price covers
  everything, and we still *see* bandwidth in the ledger.

Decision: **remove it**. Price per streamed minute by output tier,
egress folded in. Keep `bytes_out` in the session ledger and a
`cents_per_gib` rate field defaulting to 0, so if a user streams to
many viewers or we change storage, bandwidth billing is a config
change, not a feature.

### 3. Pipeline: a resumable session function, not a job

`stream_session(session_id, source_url, start_s, settings)` is one
Modal function on **L4** (1080p/1440p, DA2 + backward warp, no
inpaint) or **L40S** (4K, or VDA for temporal stability), timeout 4 h,
`nonpreemptible=True`, `SCALEDOWN_WINDOW` 30 s as everywhere:

1. `ffmpeg -ss start_s -i <url>` decodes at the output fps (≤ 30 for
   1080p, 24 for 4K). ffmpeg reads http(s), HLS, RTMP, RTSP, MMS and
   FTP like the desktop app's engine does; a live source simply has
   no `-ss`.
2. Frames go through DA2 (per-frame, >10× cheaper than VDA, matches
   the app) and the backward warp; optional letterbox trim measured
   from the first seconds like the app.
3. Output: 2 s fMP4 segments, H.264 side by side (Quest, Pico, any
   browser) and, for Vision Pro Safari, MV-HEVC via the `mvhevc-hls`
   branch's `_encode_hls_segment` (cherry-pick `cc9330f`; needs the
   on-device validation that branch never had).
4. Segments and a live playlist are written to `streams/{session}/`
   (R2 per decision 2; GCS until then). The playlist is *event* style
   (segments kept, `EXT-X-PLAYLIST-TYPE:EVENT`) so the viewer can seek
   back over what was already converted.
5. A **heartbeat** every 15 s writes `{position_s, produced_s,
   segments, bytes_written, gpu, cost_usd}` to `streams_{env}/{id}`
   and reads a `stop` flag.

**Seeking forward** past the converted range restarts the function at
the new position; the old segments stay. **Idle**: if no viewer has
fetched the playlist for 60 s the gateway sets `stop`; a later fetch
starts a new function at the last position (cold ≈ 30–40 s, warm
≈ 5 s). **Cap**: 4 h per session, 1 session per user by default,
3 for Anywhere.

Rejected: WebRTC or a persistent transport. The 5‑minute Modal web
timeout and the 120 s Cloud Run timeout make segment files the only
transport the stack already handles, and HLS is what every headset
browser plays.

### 4. Cache: the same conversion is never paid for twice

Segments are keyed by `sha256(canonical source URL + settings)` as
well as by session. A later session of the same URL and settings
serves the cached range with no GPU, and starts a function only for
the first missing segment. TTL 7 days from last access, size-capped
per user, swept by the reconciler. This is why a film watched twice
costs the allowance once: cached minutes are not metered.

The Apple app gets the same idea locally (Play Live segment cache with
TTL; see the app's ADR when written).

### 5. Metering and billing

- `streams_{env}/{id}`: `uid, source (hashed URL + host), tier,
  started_at, ended_at, produced_s, cached_s, bytes_out, gpu_s,
  cost_usd, billed_s, batch_item_id`.
- **Allowance**: `customers_{env}.stream_allowance = {period_start,
  period_end, included_s, used_s}` keyed to the RevenueCat period
  (from the webhook's `expiration_at_ms` minus the product period, or
  calendar month for lifetime). Consumed transactionally per
  heartbeat delta, modeled on `ConsumeDailyImageQuota`.
- **Overage**: the reconciler (already every 60 s) bills each active
  session's unbilled minutes past the allowance into the user's open
  **billing batch** as a `BatchItem{kind: "stream", quantity_s, tier}`
  every 15 minutes and at session end. The batch machinery closes the
  tab; nothing new on the Stripe side. Free/Pro users without the
  tier: pay as you go from minute one, card required (`requireBillable`).
- **Rates** (Firestore `config/pricing_{env}`, new fields):

| Tier | Cost basis per minute | Price per minute (≈3×) | Anywhere allowance |
|---|---|---|---|
| 1080p SBS, L4 | GPU $0.013 + egress 0 (R2) | **$0.05** | 300 min/month |
| 1440p SBS, L4 | $0.016 | **$0.06** | counted ×1.25 |
| 4K spatial, L40S | $0.033 + x265 CPU | **$0.15** | counted ×3 |

Allowance minutes are 1080p‑equivalent; a weight per tier keeps one
counter. Numbers are proposals for the user to set; the doctrine is
the existing 3× over billed cost.

### 6. Gateway surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhooks/revenuecat` | entitlement sync |
| GET | `/v1/limits` | + `stream: {allowed, tier_max, included_s, used_s, period_end, rate_card}` |
| POST | `/v1/streams` | `{url, tier, trim_bars}` → validates the URL (https/rtmp/rtsp only, public IPs, ≤ 3 redirects, HEAD/Range probe for files, `Content-Length` ≤ 8 GiB), checks entitlement/card, creates the session, returns `{id, playlist_url, page_url}` |
| GET | `/v1/streams/{id}` | status, produced range, cost so far |
| POST | `/v1/streams/{id}/seek` | `{position_s}` |
| DELETE | `/v1/streams/{id}` | stop |
| GET | `/v1/streams` | history |

The playlist URL is a signed R2/Worker URL carrying the session id;
the Worker counts bytes per session into the ledger (or Cloud CDN
logs, until R2 exists).

### 7. Web app

- `/watch`: the headset-facing page, a hosted twin of the app's served
  live page (same Tailwind design, "Spatial Video Studio" title): URL
  field, resolution, trim toggle, play. hls.js on Quest/Pico/Chrome,
  native HLS on Safari. Fullscreen SBS on a tap like the served page.
- `/account`: allowance used, period end, streaming history and cost.
- Landing and terms lose "No subscription… no monthly minimum" and
  gain the Anywhere plan with pay-as-you-go beyond it.

## Phases

1. **Entitlements**: RevenueCat webhook + pull, `customers` fields,
   `/v1/limits` publishes them. Testable with the app's sandbox
   purchases today.
2. **Session function** on Modal with URL ingest and H.264 SBS HLS to
   GCS; gateway `/v1/streams`; reconciler idle-stop and metering;
   allowance counter; overage into batches.
3. **Watch page** with hls.js; account page; copy and terms.
4. **R2 + Worker** byte counting; move segments; cache by source key.
5. **MV-HEVC segments** for Vision Pro Safari from the `mvhevc-hls`
   branch, validated on device.

## Open points for the owner

- Allowance size and the three per-minute prices (table in §5).
- Whether Pro (without Anywhere) may stream on the web pay-as-you-go
  from minute one, or whether the web needs Anywhere.
- Session cap (4 h) and concurrent sessions per tier.
- R2 versus Cloud CDN: R2 needs a Cloudflare account; Cloud CDN keeps
  everything in GCP but keeps paying egress.
