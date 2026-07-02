# Pro web client — 1 video, 1 project

Professional web app for the stereo3d pipeline. Where the mobile app is
batch-convert-and-done, this is a **project workspace**: one source video per
project, iterated through preview passes toward a production conversion, with
granular step-by-step control and per-conversion billing.

Stack (decided 2026-07-02): **Next.js on Vercel**, code in `web/` in this
repo. Auth: Firebase (same project as mobile). Payments: Stripe **Payment
Element** (web) against the same gateway PaymentIntents. All backend traffic
goes through the gateway (`gateway/`) — the web client never talks to Modal.

## Product model

```
Project (1 source video)
├── source        upload + probe (fps_rational, frames, resolution)
├── analysis      scene cuts (EDITABLE, versioned) · crop geometry · filmstrip thumbnails
├── artifacts     registry of reusable outputs from past conversions
│                   depth  (job_id, depth_res, target_fps)
│                   preprocess (job_id, trim/crop/fps meta)
└── conversions   N paid runs, each with its own auth-then-capture PaymentIntent
      kinds: depth_preview | stereo_preview | production
```

A conversion belongs to a project and snapshots the analysis version it used
(scene cuts edited later don't silently invalidate a finished run).

## Frame-accuracy doctrine

Past bugs came from float timestamps omitting or picking the wrong frame.
Rules, applied everywhere (API, storage, UI state):

1. **Edit decisions are integer frame indices**, half-open `[start, end)`,
   in **source-frame space** (the frames of the uploaded file, post nothing).
2. **fps is always the rational** (`"24000/1001"`), never a float. Floats
   appear only in display formatting.
3. **Timecode is display-layer only** (SMPTE, derived from the rational; DF
   notation for 29.97/59.94 families).
4. **One mapping implementation**: previews run at decimated fps, production
   at full fps — cuts edited on a 6 fps preview must land on identical source
   frames at 60 fps. The Modal pipeline maps source-frame cuts through its own
   trim/decimation math (`scene_cuts` param below); the gateway and web client
   never re-implement that arithmetic.
5. VFR sources are normalized to CFR by Modal's preprocess; the probe's
   `fps_rational` + `num_frames` after normalization are the project's ground
   truth, returned by the analyze step.

## Step pipeline

Steps are explicit checkpoints; each paid step is a normal gateway conversion
(auth-then-capture), so billing, support trails, and Slack alerts are
identical to mobile.

| step | what runs | artifacts | price |
|---|---|---|---|
| **Analyze** | preprocess probe + crop detect + scene detect + filmstrip thumbnails (CPU-only) | probe, auto scene cuts, crop geometry, thumbnails | free upfront; cost **credited against the project's first paid conversion** |
| **Scene review** | none (pure UI) | edited scene-cut list, versioned | — |
| **Depth preview** | draft-tier depth at reduced fps (`target_fps` ~6), `output_depth` only | depth map video (registered for reuse) | small, quoted |
| **Stereo preview** | `inpaint: "none"` fast pass, optional scene/frame-range subset, adjustable `displacement` (3D strength) | anaglyph + half-SBS preview | small, quoted |
| **Production** | full preset (ProPainter, MV-HEVC, …) with reuse options | final outputs | main charge |

End-to-end mode (mobile parity) remains: a production conversion straight
from upload, skipping previews.

### Reuse vs from-scratch

At every paid step the gateway consults the project's artifact registry (and
Modal's `/v1/reuse/lookup`) and quotes both paths:

- **Reuse** — pass `reuse_depth_from` / `reuse_preprocess_from` to Modal;
  quote drops by the covered stages' price share. Only offered when
  compatible (same effective trim/crop/fps and depth_res ≥ what the target
  needs).
- **From scratch** — full price; optionally at higher `depth_res` /
  `output_res` than any preview ran (`skip_reuse_*` set so nothing stale is
  picked up silently).

The UI shows the delta explicitly ("Reuse preview depth — save $X · or
recompute at 4K quality").

## API extensions

### Modal API (this repo, `app/`)

1. **`scene_cuts` request param on `POST /v1/videos`** *(new)* — sorted list
   of source-frame indices (cut = first frame of a new scene), validated
   in-range; pipeline maps them through trim + fps decimation to work-file
   boundaries and **skips detection** (and the scenes reuse cache) when
   present. Used by the depth fan-out and the adaptive profiler.
2. **Analyze mode** — composition of existing pieces (`preprocess` probe,
   `/v1/stages/scene-detect`, `/v1/stages/crop-detect`) plus new filmstrip
   thumbnail generation (e.g. 1 jpeg/scene + every Nth frame strip) exposed
   as one job: `POST /v1/analyze`. Returns probe (with `fps_rational`), auto
   scene cuts **in source-frame space**, crop geometry, thumbnail URLs.
3. Depth/stereo previews need **no Modal changes** (existing params: preset
   draft, `target_fps`, `output_depth`, `inpaint: "none"`, `from_frame`/
   `to_frame` — note: extend gateway to pass `from_frame`/`to_frame` instead
   of `from_sec`/`to_sec`, per the frame doctrine).

### Gateway (`gateway/`)

New resources (same auth/envelope conventions):

```
POST   /v1/projects                      create from an upload (starts free Analyze)
GET    /v1/projects                      list mine
GET    /v1/projects/{id}                 project + analysis + artifacts + conversions
PATCH  /v1/projects/{id}/scenes          replace scene-cut list (frame indices; versioned)
POST   /v1/projects/{id}/quotes          quote a step {step, params, reuse: auto|none}
                                         → both reuse & from-scratch prices when applicable
POST   /v1/projects/{id}/conversions     create paid step conversion (existing PI flow)
DELETE /v1/projects/{id}                 archive (cancels active conversions)
```

Data model additions (Firestore):

- `projects_{env}/{id}`: uid, source (gcs_key + probe incl. fps_rational),
  scenes {version, cuts[], edited_by_user, updated_at}, crop, thumbnails,
  analyze {job_id, cost_usd, credit_cents, credit_consumed_by}, created_at.
- `conversions_{env}` gains: `project_id`, `step`
  (production|depth_preview|stereo_preview), `reuse {depth_from,
  preprocess_from}`, `scenes_version`, and frame-based trim
  (`from_frame`/`to_frame` replacing seconds).
- Artifact registry is derived: succeeded conversions of a project are
  scanned for reusable outputs (depth job ids + their depth_res/target_fps).

Pricing config additions: per-step rates (`depth_preview_cents_per_minute`,
`stereo_preview_cents_per_minute`), stage shares for reuse discounts
(e.g. depth 35% of a production run), and the analyze credit amount.
The analyze credit applies as a discount line on the project's first paid
conversion (`credit_consumed_by` guards double-spend).

### Web client (`web/`)

Next.js (App Router, TypeScript). Key screens:

1. **Projects** — list + upload dropzone (signed PUT, resumable for multi-GB).
2. **Project workspace** — the core screen:
   - filmstrip timeline with scene-cut markers: click to add, drag to nudge
     (snaps to frames), delete false positives; frame-stepping viewer
     (◀︎ ▶︎ = ±1 frame) with timecode + frame index readout;
   - step rail: Analyze ✓ → Scenes → Depth preview → Stereo preview →
     Production, each showing state/cost/artifacts;
   - depth preview player (side-by-side source/depth), stereo preview player
     (anaglyph mode), displacement slider (server-clamped range);
   - conversion history table: every run with params, quote vs captured,
     state, conversion_id (click-to-copy for support), downloads.
3. **Checkout** — Stripe Payment Element bound to the gateway's PaymentIntent
   client_secret (same auth-then-capture; wallet buttons included).
4. **Account** — Firebase sign-in, payment methods, receipts.

State/polling: SWR against `GET /v1/conversions/{id}` (the gateway's
read-through poll keeps it fresh); no client-side Modal access, no client-side
price math (quotes always come from `POST /v1/projects/{id}/quotes`).

## Build order

1. Modal: `scene_cuts` param + `/v1/analyze` (+ thumbnails stage).
2. Gateway: projects resource, step quotes/pricing, frame-based trim,
   artifact registry, analyze credit.
3. Web: scaffold → projects/upload → workspace (scenes editing first, it
   exercises the whole frame doctrine) → previews → checkout → history.
4. Mobile app re-points to the gateway afterward (unchanged plan).
