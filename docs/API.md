# API reference

Base URL (test): `https://stereo-crafter-test--stereo3d-api-test.modal.run`

**Auth**: the test deployment is open (direct R&D use). The **prod**
deployment sets `requires_proxy_auth=True` — requests need
`Modal-Key`/`Modal-Secret` headers with a workspace proxy-auth token, and in
practice only the [gateway](../gateway/DESIGN.md) calls it; apps never talk
to this API directly.

All bodies are JSON. Input paths are bucket-relative
(`inputs/samples/videos/clip_1s_480p.mp4`) or full
`gs://spatial-video-studio-app/stereo3d/<env>/...` URIs.
Outputs are public `storage.googleapis.com` URLs.

Job tracking uses **custom job ids** stored in a `modal.Dict`
(~7-day retention) — never Modal function-call ids, whose history
expires after a day. Poll `GET /v1/jobs/{job_id}`.

Every job also produces a **cost breakdown**: each timed stage drops
`costs/<stage>.yaml` next to the job's outputs in GCS, completion rolls
them up into `costs/cost.yaml`, and the same summary appears as
`cost_summary` in the job status (plus an optional Slack notification —
see `notify`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/analyze` | probe + crop detect + scene detect + filmstrip thumbnails (CPU-only, pro step pipeline) |
| POST | `/v1/videos` | full 2D→3D video pipeline |
| POST | `/v1/images` | full 2D→3D image pipeline (single or batch) |
| GET | `/v1/jobs/{job_id}` | poll status / outputs / timings / cost |
| DELETE | `/v1/jobs/{job_id}` | cancel a pending/running job (and its GPU workers) |
| POST | `/v1/reuse/lookup` | check the reuse cache without submitting a job |
| POST | `/v1/stages/*` | experimental: run pipeline segments in isolation |
| GET | `/health` | liveness + environment |

---

## POST /v1/analyze — source analysis (pro step pipeline)

CPU-only, cheap. Runs on the **source file** (no preprocess), so every frame
index in the result is source-frame space — directly usable as `scene_cuts`
on `POST /v1/videos` after the user edits them.

Body: `{"input_path": <required>, "remove_black_bars"?: bool (default true —
gates crop detection), "strip_count"?: int [10, 300] (default 100)}`.

Same job envelope as every pipeline (`job_id` + poll `GET /v1/jobs/{job_id}`).
On completion, `metadata` carries:

```jsonc
{
  "probe": { "width": 1920, "height": 1080, "fps": 23.976,
             "fps_rational": "24000/1001", "num_frames": 2878, ... },
  "crop": "1920:800:0:140",           // or null
  "scenes": [ {"start": 0, "end": 233, "start_sec": 0.0, "end_sec": 9.718}, ... ],
  "scene_cuts": [233, 610, ...],      // source frames, /v1/videos-ready
  "thumbnails": {
    "strip":  [ {"frame": 0, "url": "https://..."}, ... ],   // ~strip_count timeline tiles (h=90)
    "scenes": [ {"scene": 0, "frame": 116, "url": "https://..."}, ... ]  // mid-frame keyframes (h=480)
  }
}
```

## POST /v1/videos — full video pipeline

```jsonc
{
  "input_path": "inputs/samples/videos/clip_10s_scenes_1080p.mp4",  // required
  "preset": "qhd",                 // bundles output/depth/inpaint res (see table)
  "formats": ["sbs", "half_sbs", "anaglyph", "mvhevc"],
  "include_audio": true,
  "output_depth": true,
  "depth_model": "vda",
  "depth_res": 980,                // depth inference res (alias of input_size)
  "output_res": 1440,              // output short side
  "inpaint_res": 720,              // inpaint short side (dual-res when < output_res)
  "displacement": 0.0125,
  "inpaint": "propainter",
  "parallel": true,                // scene-aligned multi-GPU fan-out
  "max_gpu_workers": 4,
  "spatial": {"hero": "left", "baseline_mm": 19.24, "hfov_deg": 63.4, "dadj": 200}
}
```

→ `{"job_id": "…", "status": "pending", "status_url": "/v1/jobs/…"}`

Only `input_path` is required. Everything else defaults as below.

### Output

| Param | Type | Default | Description |
|---|---|---|---|
| `input_path` | string | — (required) | bucket-relative path or `gs://` URI |
| `formats` | list | `["sbs", "half_sbs", "anaglyph"]` | any of `sbs`, `half_sbs`, `tb`, `half_tb`, `anaglyph`, `mvhevc`. `mvhevc` is encoded by a separate stage from the raw stereo master; a request with **only** `mvhevc` skips the SBS-family encode entirely |
| `include_audio` | bool | `true` | mux source audio into outputs (trim-aware) |
| `output_depth` | bool | `true` | also publish the gray16 depth video as `outputs.depth` (and register it for content-addressed reuse), **plus** a browser-playable 8-bit preview as `outputs.depth_vis` (yuv420p H.264, short side ≤ 720, no upscale — produced even when the depth itself was reused; never part of the reuse key) |
| `stereo_mode` | string | `"both"` | `both` \| `left` \| `right` — which eye(s) are synthesized (`m2svid` defaults to `right`; its left eye is always the original frame) |
| `notify` | bool | `true` | Slack lifecycle messages (submit/complete/fail, incl. cost). No-op without a webhook |

### Depth

| Param | Type | Default | Description |
|---|---|---|---|
| `depth_model` | string | `"vda"` | `vda` (temporal, the web default) \| `da2` (per-frame relative Depth-Anything-V2-Large — matches the mobile app's on-device model; outputs disparity natively) \| `da3` \| `da3-metric` \| `depth-pro`. `vda` is the temporally-stable video model; the others run per-frame on a single L40S (no fan-out; metric models need one job-wide normalization pass). `depth-pro` (R&D, apple-amlr weights) additionally reports per-scene mean `fov_deg` in metadata |
| `depth_res` | int | `980` | depth inference resolution (short side). Multiple of 14 in **[140, 2520]**. Client-facing alias of `input_size` — sets it only when `input_size` is absent, and resolves **before** the preset merge, so an explicit `depth_res` overrides a preset's depth resolution (an explicit `input_size` still wins over both). The real VRAM guard is the working-megapixel GPU router (below) |
| `input_size` | int | `980` | internal name for `depth_res`; same ×14 / [140, 2520] rule |
| `encoder` | string | `"vitl"` | `vitl` \| `vits` — VDA backbone (vda only) |

### Resolution & stereo (v7 dual-res)

| Param | Type | Default | Description |
|---|---|---|---|
| `output_res` | int | source | output **short side** in px, **[540, 4320]**. Preprocess never upscales past the source |
| `inpaint_res` | int | `720` | inpaint (ProPainter) **short side**, **[360, 2160]**, must be ≤ `output_res`. When smaller than the output, dual-res engages: splat/composite at output res, fill at inpaint res. Both dims rounded to multiples of 8 |
| `work_height`, `work_width` | int | — | legacy explicit ProPainter working resolution; both must be set to take effect (overrides `inpaint_res`) |
| `displacement` | float | `0.0125` | max disparity as fraction of width, **(0, 0.1]** |
| `inpaint` | string | `"propainter"` | `propainter` (best) \| `migan` (per-frame MI-GAN fill on the L4 lite tier — filled edges at near raw-warp cost, no temporal stabilization; forward warp only) \| `none` (raw warp, fastest) \| `m2svid` (R&D diffusion fill on A100-80GB; runs at its fixed ~512 model tier — work res knobs don't apply) |
| `warp` | string | `"forward"` | stereo synthesis method, orthogonal to `inpaint`. `forward` = scatter splat with occlusion masks (the only method an inpaint model can follow) \| `backward` = gather warp (same kernel as the iOS/macOS/visionOS app: one sampling pass, no holes, no inpainting, CPU-capable). `backward` **requires** `inpaint: "none"` — any other pairing is a 400 |
| `preset` | string | — | resolution/quality bundle, see below. Explicit request fields always win over the preset |

### Presets

| Preset | Output height | Depth res (`input_size`) | Extras |
|---|---|---|---|
| `draft` | 1080 | 518 | `inpaint: "none"` |
| `1080p` | 1080 | 980 | — |
| `qhd` | 1440 | 1148 | 2560×1440, all-L40S |
| `3k` | 1620 | 1148 | 2880×1620, all-L40S |
| `4k` | 2160 | 1442 | `inpaint_res: 1080`; H200 stereo |

### Apple spatial video (`mvhevc` format)

The `mvhevc` format produces an Apple Vision Pro **spatial video**
.mov (device-verified: Photos badge + clean scene cuts). Default encoder
is **x265 multiview** on CPU — the only Linux encoder whose VPS signaling
Apple's spatial classifier accepts. Both paths: MP4Box mux (hvcC+lhvC) +
byte-exact vexu/hfov injection.

| Param | Type | Default | Description |
|---|---|---|---|
| `mvhevc_encoder` | string | `"x265"` | `x265` = Apple spatial badge (CPU); `nvenc` = fast L4 GPU path (plays in custom players, no Photos badge) |
| `spatial.hero` | string | `"left"` | `left` \| `right` \| `null` — hero eye |
| `spatial.baseline_mm` | float | `19.24` | virtual camera baseline |
| `spatial.hfov_deg` | float | `63.4` | horizontal field of view |
| `spatial.dadj` | int | `200` | disparity adjustment in 1/10000-of-width units (200 = +0.02) |

### Trim & frame selection

| Param | Type | Default | Description |
|---|---|---|---|
| `from_frame`, `to_frame` | int | full clip | keep `[from_frame, to_frame)` — half-open, frame-exact, canonical. Omit start ⇒ 0, end ⇒ end |
| `from_sec`, `to_sec` | float | — | convenience; converted to frames via the source fps (rounded). Prefer frames for exactness (e.g. depth-reuse alignment). Audio is cut to the same window; trimming re-encodes to clean H.264 |
| `target_fps` | float | source fps | decimate to fewer fps, **(0, 240]** (capped at the source rate). Decimation recorded in `metadata.fps_decimation` |
| `crop` | string | auto | explicit `"W:H:X:Y"` ffmpeg crop geometry (a `crop=` prefix is accepted). Forces a crop past auto black-bar detection — for letterboxes the multi-sample detector's conservatism misses. Requires `remove_black_bars` (default on) |
| `remove_black_bars` | bool | `true` | auto-detect and crop letterbox/pillarbox bars |
| `scene_cuts` | int[] | auto-detect | user-edited scene cuts: **source-frame** indices, each the first frame of a new scene, strictly increasing, > 0. Bypasses scene detection AND the scenes reuse cache (used by both the depth stage and the adaptive profiler). The pipeline maps them through trim + fps decimation to work-file boundaries — exact under divisor decimation, nearest-frame under resample. Cuts outside the trim window are dropped. Scene cuts are part of the **depth reuse key** (per-scene depth normalization resets at cuts, so different cut lists are different depth artifacts): only a run with the same cut list — and auto-detect only another auto-detect run — reuses a cached depth |

### Per-scene stereo overrides (`scene_overrides`)

User-supplied per-scene overrides, keyed by **source-frame scene start**
(same space as `scene_cuts` — frame doctrine: integer source-frame
indices, validated exactly, never snapped):

```jsonc
"scene_overrides": [
  {"first": 0,   "displacement": 0.012},
  {"first": 266, "shot_type": "dynamic"},
  {"first": 980, "displacement": 0.008, "shot_type": "close_up"}
]
```

| Field | Type | Rules |
|---|---|---|
| `first` | int | required, ≥ 0, strictly increasing across entries. Must be **0 or one of the job's scene starts** (a `scene_cuts` value); checked at submit when `scene_cuts` is in the request, otherwise a non-matching `first` **fails the job** (never silently snapped/dropped) |
| `displacement` | float | optional, **(0, 0.1]** — sets the shot's displacement flat (a manual value is exactly what renders: any per-keyframe ramp on that shot is dropped) |
| `shot_type` | string | optional, `close_up` \| `standard` \| `dynamic` \| `wide` — re-derives displacement + placement from the shot-type table (× the job's depth scale), unless an explicit `displacement`/`placement` also given (those win) |
| `placement` | [float, float] | optional, `[far, near]` each in **[-1.5, 1.5]** with far < near — explicit depth-budget placement, wins over derived |

Each entry needs at least one of `displacement`/`shot_type`/`placement`;
unknown keys are rejected (**422**). Semantics:

- **with `adaptive: true`** — overrides are applied to the profiler's
  depth script **after** its smoothing/cut-matching/comfort passes (user
  override = final word; comfort clamps are not re-run over overridden
  shots). Applied overrides are recorded on the affected
  `metadata.depth_script` entries as `"override": {…}`.
- **without adaptive** — per-scene params are synthesized directly (no
  profiler, no extra GPU): every scene gets the job-wide `displacement`
  default + the standard placement, then the overrides edit their scenes.
  The result lands in `metadata.depth_script` like an adaptive script.
- an override for a scene entirely outside the trim window is dropped
  with a job-log warning (same handling as a trimmed-out cut).
- composes with everything the adaptive script composes with: both
  inpaint backends, sequential and parallel (the params key on absolute
  frame index).
- the raw request list is echoed back as `metadata.scene_overrides`.

### Adaptive per-shot depth script (R&D)

Detects scenes, profiles 3 keyframes per shot, and drives per-shot
displacement/placement through the stereo stage. Decisions land in
`metadata.depth_script` and are also published as a durable
`depth_script.yaml` sidecar. Composes with the fan-out (the script keys
on absolute frame index). Auto-disabled at draft frame rates
(effective fps ≤ 3). The `profiler`/`depth_scale`/`auto_comfort`/
`comfort_budget` fields are **rejected with 400 unless `adaptive: true`**.

| Param | Type | Default | Description |
|---|---|---|---|
| `adaptive` | bool | `false` | enable the per-shot depth script |
| `profiler` | string | `"da3-metric"` | `da3-metric` \| `depth-pro` — profiling backend, independent of the main `depth_model`. `depth-pro` profiles in true meters and adds a shot-mean FOV classification modifier (script entries gain `fov_deg`) |
| `depth_scale` | float | `1.0` | **[0.3, 1.5]** — uniform multiplier on every shot's displacement; preserves the script's relative structure, comfort caps stay hard limits. An explicit value **overrides** `auto_comfort` |
| `auto_comfort` | bool | `true` | auto-pick the scale that lands the clip's p95 salient screen disparity within `comfort_budget`; only ever tones **down**. Chosen scale → `metadata.comfort_scale` |
| `comfort_budget` | float | `0.02` | **(0, 0.05]** — target peak salient screen disparity (fraction of width); 0.02 = broadcast background-divergence bracket |

### Reuse (content-addressed cache + explicit job pointers)

Preprocess work files, depth maps and scene-cut lists are keyed by
content (source + the request fields that affect them) and auto-reused
by default — an identical rerun skips those stages. Auto-reuse Slack-pings
on every hit.

| Param | Type | Default | Description |
|---|---|---|---|
| `reuse_depth_from` | string | — | job id of a prior run on the **same** source/crop/resolution: skip the depth pass and use its published depth. Frame count + dimensions are verified against this run's preprocess. Works **cross-env** (reads the shared GCS prefix). Get an id from `POST /v1/reuse/lookup` |
| `reuse_preprocess_from` | string | — | job id whose published work file to reuse; **requires** `preprocess_meta` (400 without it). Cross-env, wins over auto-reuse |
| `preprocess_meta` | object | — | source-derived metadata for `reuse_preprocess_from` (`source_fps`, `trim`, `crop`, `fps_decimation`, `splat_relpath`) — returned verbatim by `/v1/reuse/lookup` |
| `skip_reuse_preprocess` | bool | `false` | force a preprocess recompute (result still re-registered) |
| `skip_reuse_depth` | bool | `false` | force a depth recompute |
| `skip_reuse_scenes` | bool | `false` | force scene re-detection (adaptive path) |

### Long-video fan-out

Long videos split into scene-aligned chunks across parallel GPU workers;
output is identical to sequential (depth alignment resets at cuts, stereo
segments align to batch boundaries). A heartbeat watchdog resubmits hung
chunks on fresh containers instead of failing the job.

| Param | Type | Default | Description |
|---|---|---|---|
| `parallel` | bool | auto | fan out depth + stereo. Auto-enabled above **1500 frames** |
| `max_gpu_workers` | int | `4` | concurrent GPU containers per fan-out stage (workspace ceiling: 10 GPUs) |
| `stereo_chunk_frames` | int | `1200` | max frames per stereo chunk — smaller ⇒ more, shorter chunks |
| `depth_chunk_frames` | int | `1500` | max frames per depth chunk |
| `stall_timeout_s` | int | `240` | watchdog: fail/resubmit if no worker emits progress for this long |

### GPU routing (automatic)

**Depth (vda)** routes on working megapixels — `depth_res² × (long/short)
/ 1e6`, aspect- and orientation-agnostic:

| Working MP | GPU |
|---|---|
| ≤ 2.5 (≈ depth_res 1184 @ 16:9) | L40S |
| ≤ 6.5 (≈ depth_res 1912 @ 16:9) | H200 |
| ≤ 8.5 | B200 |
| above | job fails (no tier fits) |

Per-frame depth models (`da3`/`da3-metric`/`depth-pro`) always run on a
single L40S. **Stereo**: H200 when the inpaint work area exceeds
1280×720 **or** the splat surface exceeds 2560×1440, else L40S;
`m2svid` runs on A100-80GB. **MV-HEVC**: x265 on a 32-core CPU
container, nvenc on L4.

---

## POST /v1/images — image pipeline (single or batch)

```jsonc
{
  // batch form:
  "items": [
    {"input_path": "inputs/samples/images/004_qO-PIF84Vxg.jpg",
     "item_id": "pup4",             // optional, defaults to filename stem
     "displacement": 0.01,
     "stereo_mode": "both",
     "formats": ["lr", "anaglyph"],
     "output_depthmap": true,
     "remove_black_bars": true}
  ],
  // or single-image shorthand instead of items:
  // "input_path": "inputs/samples/images/x.jpg",

  // any per-item field given top-level becomes the default for all items:
  "formats": ["lr", "tb", "half_lr", "half_tb", "anaglyph"]
}
```

Per-item fields (each also accepted top-level as a batch default;
per-item values win):

| Param | Type | Default | Description |
|---|---|---|---|
| `input_path` | string | — (required) | per item |
| `item_id` | string | filename stem | must be unique across the batch (400 on duplicates) |
| `displacement` | float | `0.01` | max disparity as fraction of width |
| `stereo_mode` | string | `"both"` | `both` \| `left` \| `right` |
| `inpaint` | string | `"lama"` | forward-warp fill model: `lama` \| `migan` (per-still MI-GAN — the mobile app's on-device inpainter) \| `none` (raw splat, holes left) |
| `warp` | string | `"forward"` | `forward` (splat + LAMA fill of the holes) \| `backward` (gather warp, app-parity kernel; LAMA never runs) |
| `formats` | list | `["lr"]` | any of `lr`, `tb`, `half_lr`, `half_tb`, `anaglyph` (unknown names fail the item) |
| `output_depthmap` | bool | `true` | also publish the depth map |
| `remove_black_bars` | bool | `true` | auto-crop bars |

Items are processed independently: the job completes if **any** item
succeeds (`error` reports the failed count), and `outputs` maps
`item_id → {output name → URL}` (always including `left`/`right` PNGs).

---

## GET /v1/jobs/{job_id} — job status

```jsonc
{
  "job_id": "…", "kind": "video",            // "video" | "image" | "stage:…"
  "status": "in_progress",                   // pending | in_progress | completed | failed
  "stage": "video_stereo", "progress": 0.62, // overall 0..1
  "created_at": 1751414400.0, "updated_at": 1751414455.2,
  "request": { … },                          // the submitted body, echoed back
  "progress_detail": {                       // updated every ~30 frames / 5s
    "stage": "video_stereo", "done": 90, "total": 240, "unit": "frames",
    "rate_per_s": 0.7, "eta_seconds": 210
  },
  "outputs": {                               // name -> public URL (on completion)
    "sbs": "https://…", "half_sbs": "https://…", "anaglyph": "https://…",
    "mvhevc": "https://…", "depth": "https://…",
    "depth_vis": "https://…"                 // 8-bit browser preview of depth (output_depth)
  },
  "timings": [                               // per-stage benchmark + cost records
    {"stage": "preprocess", "seconds": 4.1, "gpu": null,
     "cost": {"total_usd": 0.0012, "gpu_usd": 0.0, "cpu_usd": 0.0009, "mem_usd": 0.0003},
     "detail": {"crop": "3840:1664:0:248"}},
    {"stage": "video_depth", "seconds": 63.0, "gpu": "L40S",
     "cost": {"total_usd": 0.036, …}, "detail": {"input_size": 980}}
  ],
  "cost_summary": {                          // set on completion (also costs/cost.yaml in GCS)
    "total_usd": 0.31, "gpu_usd": 0.27, "cpu_usd": 0.03, "mem_usd": 0.01,
    "total_seconds": 412.5, "stage_count": 6,
    "by_gpu_usd": {"L40S": 0.11, "H200": 0.16},
    "stages": [{"stage": "video_depth", "seconds": 63.0, "gpu": "L40S", "total_usd": 0.036}, …]
  },
  "metadata": {                              // video jobs, on completion
    "probe": {"width": 2560, "height": 1440, "num_frames": 240, "fps": 24.0, …},
    "crop": "3840:1664:0:248",               // applied crop, or null
    "fps_decimation": null,                  // {"fps": …, …} when target_fps decimated
    "scene_cuts": [27, 58],
    "depth_shape": [1440, 2560],
    "av_sync_ms": {"sbs": 0},                // per-output audio offset check
    "depth_script": [{"first": 0, "last": 27,          // WORK-space span (stereo stage)
                      "first_src": 0, "last_src": 54,  // SOURCE-space span (web client;
                                                       // half-open: next cut or clip end)
                      "shot_type": "wide", "displacement": 0.014, "placement": …,
                      "override": {"displacement": 0.014},  // present when a
                                                       // scene_override was applied
                      …}],                             // adaptive OR scene_overrides
    "scene_overrides": [{"first": 0, "displacement": 0.014}],  // raw request echo
    "comfort_scale": 0.85,                   // adaptive only: auto_comfort's chosen scale
    "fov_deg": [63.1, 58.4]                  // depth-pro only: per-scene mean HFOV
  },
  "error": null                              // failure reason on status "failed"
}
```

Notes:
- `progress_detail` fan-out stages aggregate `done` across chunks so
  progress stays monotonic; `rate_per_s`/`eta_seconds` only appear once
  a rate is measurable.
- image jobs put `{item_id: {name: url}}` in `outputs` and have no
  `metadata`.
- experimental stage jobs put the worker's return value in `result`.
- during a fan-out, `child_call_ids` lists the spawned GPU workers'
  FunctionCall ids (used by cancel; cleared when the stage gathers).

## DELETE /v1/jobs/{job_id} — cancel

Cancels the coordinator **and every GPU worker it spawned**
(`child_call_ids` — children first, so none outlive the coordinator).
The job is marked `failed` with
`error: "cancelled by user (cancelled N GPU worker(s))"` and the updated
record is returned. Cancelling an already-terminal job is a no-op that
returns the record as-is. Unknown id → 404.

## POST /v1/reuse/lookup — production reuse helper

Checks the content-addressed reuse cache for a given video request
**without submitting a job**: computes the same preprocess/depth/scenes
keys the pipeline would and reports any cached artifacts. Use the
returned depth `job_id` as `reuse_depth_from` to skip the depth pass —
that path reads the published GCS artifact, so it works **across
environments** (the cache Dict itself is per-env). No GCS existence
check — entries reflect what was registered.

Request: the same `POST /v1/videos` fields that affect the keys —
`input_path` (required); `preset`, `remove_black_bars`, `output_res`,
`target_height`, `target_fps`, `crop`, trim fields
(`from_frame`/`to_frame`/`from_sec`/`to_sec`), `depth_res`/`input_size`,
`depth_model`, `encoder`, `scene_cuts` (optional, defaults as in
`/v1/videos`). The keys are computed through the pipeline's own request
normalization (preset merge + `depth_res` alias included), so passing the
**exact body you would submit** yields exactly the keys the job will use.

```jsonc
// response
{
  "env": "test",
  "preprocess": {"key": "pp:…", "cached": true, "job_id": "1a2b3c4d5e6f",
                 "gcs_relpath": "outputs/1a2b3c4d5e6f/preprocess.mp4",
                 "created_at": 1751414400.0,
                 "meta": {"source_fps": 24.0, "source_num_frames": 2878,
                          "trim": null, "crop": null,
                          "fps_decimation": null, "splat_relpath": null}},
  "depth":  {"key": "d:…", "cached": false},
  "scenes": {"key": "s:…", "cached": false},
  "reuse_depth_from": null       // depth job_id when cached — pass straight through
}
```

To reuse a cached preprocess, pass `reuse_preprocess_from: <job_id>` +
`preprocess_meta: <meta>` from the `preprocess` entry.

---

## Experimental stage endpoints

Test pipeline segments in isolation. Same submit/poll shape; results
appear in the job's `result` field.

| Endpoint | Body | Does |
|---|---|---|
| `POST /v1/stages/video-depth` | `{input_path, input_size?: 980, encoder?: "vitl", depth_model?: "vda"}` | depth video only (cache path + scene cuts) |
| `POST /v1/stages/video-stereo` | `{video_path, depth_path, displacement?: 0.0125, inpaint?: "propainter", warp?: "forward"}` | splat+inpaint from an existing depth video (cache paths from a previous stage) |
| `POST /v1/stages/encode-mvhevc` | `{sbs_path, encoder?: "x265", crf?: 23, preset?: "medium", quality?: 28 (nvenc), spatial?}` | spatial MV-HEVC .mov from an existing SBS master |
| `POST /v1/stages/scene-detect` | `{input_path}` | scene cut list |
| `POST /v1/stages/crop-detect` | `{input_path}` | black-bar geometry + cropped copy in cache |

## GET /health

→ `{"status": "ok", "env": "test"}`

## Errors

Validation failures return **400** with a `detail` string, e.g.:

```jsonc
{"detail": "input_path is required"}
{"detail": "displacement must be in (0, 0.1]"}
{"detail": "input_size must be a multiple of 14 in [140, 2520]"}
{"detail": "inpaint_res must not exceed output_res (filling above the output frame is wasted)"}
{"detail": "profiler is only meaningful with adaptive=true"}
{"detail": "crop must be 'W:H:X:Y' (four integers)"}
{"detail": "reuse_preprocess_from requires preprocess_meta (get both from POST /v1/reuse/lookup)"}
{"detail": "duplicate item_id in items"}
```

Malformed `scene_overrides` return **422** with a per-entry `detail`, e.g.:

```jsonc
{"detail": "scene_overrides[1]: unknown key(s) ['displ'] (allowed: first, displacement, shot_type, placement)"}
{"detail": "scene_overrides[0].first must be strictly increasing (got 10 after 10)"}
{"detail": "scene_overrides[2].first=100 is not a scene start (must be 0 or one of scene_cuts)"}
{"detail": "scene_overrides[0].displacement must be a number in (0, 0.1]"}
{"detail": "scene_overrides[0].placement must be [far, near] floats in [-1.5, 1.5] with far < near"}
```

Unknown job ids return **404**: `{"detail": "unknown job: deadbeef1234"}`.
Runtime failures (bad media, depth/stereo frame mismatch, GPU ceiling
exceeded) surface as job `status: "failed"` with the reason in `error`,
not as HTTP errors.

## Polling pattern

```python
import requests, time
BASE = "https://stereo-crafter-test--stereo3d-api-test.modal.run"
job = requests.post(f"{BASE}/v1/videos", json={"input_path": "inputs/samples/videos/clip_1s_480p.mp4"}).json()
while True:
    s = requests.get(BASE + job["status_url"]).json()
    if s["status"] in ("completed", "failed"):
        break
    time.sleep(10)
print(s["outputs"], s.get("cost_summary"))
```
