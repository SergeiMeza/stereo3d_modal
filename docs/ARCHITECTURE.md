# Architecture

## Goals (and the mistakes they fix)

1. **Plain-JSON API.** The old project used Pydantic classes for
   request/response; library upgrades changed validation semantics and
   broke payloads silently. Here every payload is a plain dict;
   `app/api/schemas.py` documents shapes as TypedDicts (type hints
   only). Validation is explicit `.get()` + checks in handlers.
2. **One image per pipeline segment.** The old shared mega-image meant
   any dependency tweak rebuilt (and risked breaking) everything.
   Images live in `app/images/`; the stable layers (CUDA base, apt,
   pinned torch) come first so iteration only rebuilds the tail layers.
3. **Weights out of images.** Checkpoints live in the
   `stereo3d-weights` Volume, fetched on first container start
   (`app/common/weights.py`). Rebuilding an image never re-downloads
   weights; adding a model never rebuilds an image.
4. **Tensor tracking.** `app.common.debug.track()` logs
   shape/dtype/device/range at stage boundaries (disable with
   `TRACK_TENSORS=0`).
5. **Benchmarks built in.** Every stage runs under
   `jobs.stage_timer(...)`, so each job's `timings` is a benchmark
   record; `scripts/benchmark.py` just drives the matrix and formats
   the report.
6. **Modern Modal API** (1.2.x): `@modal.concurrent`, `modal.parameter`,
   `uv_pip_install`, `add_local_python_source`, no deprecated kwargs.

## Stages and GPUs

| Stage | Container | GPU | Why |
|---|---|---|---|
| preprocess / encode / orchestration | `media_image` (debian_slim + ffmpeg) | none | probing, cropdetect, scene detect, muxing are CPU-bound |
| video depth (VDA) | `video_depth_image` | L40S / H200 / B200 | routed by **working megapixels** (see below); VRAM scales with the model's working pixel count |
| video depth (per-frame: DA2/DA3/Depth Pro) | `video_depth_image` | L40S (fixed) | per-frame inference is much lighter than VDA's 32-frame windows |
| video stereo (splat + ProPainter) | `stereo_image` | L40S / H200 | H200 when the inpaint work res exceeds 1280×720 **or** the splat surface exceeds 2560×1440 px |
| video stereo (M2SVid — **deprecated**, net-harmful per A/B test) | `m2svid_image` | A100-80GB (fixed) | 25-frame SVD UNet with full attention; 48 GB L40S too risky |
| MV-HEVC encode | `nvenc_image` | L4 (NVENC path) / none (x265 path, 32 CPU cores) | NVENC is fixed-function; x265 is pure CPU |
| image pipeline | `image_stereo_image` | A10G | DA2-Large fp16 + LAMA fit comfortably; cheapest adequate GPU |

GPU concurrency is bounded by the workspace limit (10 GPU containers);
fan-out is further capped per job by `max_gpu_workers` (default 4).
Stages are separate Modal functions, so a long video can have depth and
stereo running on different containers across jobs, but within one job
stages are sequential (stereo needs depth).

### Depth GPU routing — working megapixels (`_route_depth_gpu`)

VDA depth's VRAM is driven by the **working pixel count**, not by
`depth_res` (`input_size`) alone: the model resizes the SHORT side to
`input_size` and the long side follows the source aspect, so

    work_mp = input_size² × elongation / 1e6   (elongation = long/short ≥ 1)

Routing is on `work_mp` — a single aspect- and orientation-agnostic axis
(the old 16:9-calibrated `eff_size` proxy over-capped square content and
could mis-route ultra-wide). Thresholds (`app/pipelines/video.py`):

| tier | condition | ~depth_res on 16:9 |
|---|---|---|
| L40S | work_mp ≤ 2.5 | ≤ ~1184 (matches the old ≤1148 tier) |
| H200 | work_mp ≤ 6.5 | ≤ ~1912 (1806 @ 5.80 MP is the proven max) |
| B200 | work_mp ≤ 8.5 | VRAM-ceiling tier only (2100 @ 2.39:1 = 7.84 MP proven) |
| — | work_mp > 8.5 | fail fast (`ValueError`) |

**A100 is dropped from routing entirely** (H200 is faster and
~cost-neutral). B200 (~180 GB, Blackwell cu128 torch stack) exists purely
for work H200's 141 GB physically cannot fit — it is NOT cost-competitive
at resolutions H200 handles (58% pricier/s at ~0.74× the throughput).

### Stereo GPU routing

ProPainter stereo runs on L40S and escalates to H200 when
`work_h × work_w > 1280 × 720` (a big inpaint work res) or the splat
surface exceeds `2560 × 1440` px (4K splat/composite buffers need
~80+ GB). M2SVid is fixed on A100-80GB and **deprecated**.

## Video depth: scene-aware streaming (DepthProcessor)

Migrated from the old `scene_video_depth.py` (the production-quality
path, a.k.a. `video_depth_model_v2`):

- VideoDepthAnything v3 consumes 32-frame windows (`INFER_LEN`) with 10
  overlap frames (`OVERLAP`); keyframe depth from the previous window
  is re-fed for temporal consistency.
- Inter-window alignment solves least-squares scale/shift on keyframe
  depth; the 8 boundary frames (`INTERP_LEN`) are linearly blended.
- A `scenedetect.AdaptiveDetector` thread feeds cut frame numbers into
  a queue; each scene is processed and normalized independently, so
  depth never bleeds across cuts.
- Output streams through an ffmpeg pipe as 16-bit grayscale
  (`gray16le`) at the model's working resolution; downstream upsamples.
  Memory stays bounded regardless of clip length.

## Video stereo: splat + inpaint

- `DepthSplatter` (Forward-Warp CUDA op) produces left/right views and
  occlusion maps. **Raw warp output — no blurs or mask feathering**
  (empirically the best-looking warp).
- `inpaint="propainter"`: occlusion masks are dilated (3×3, 2
  iterations) and filled by ProPainter (RAFT flow → flow completion →
  propagation → sparse transformer) at a working resolution derived
  **orientation-agnostically** from a short-side value (`inpaint_res`,
  default 720) and the source aspect, both dims rounded to /8 for
  RAFT's flow grid — 1280×720 for 16:9, 720×1280 for 9:16, etc. The
  fill is upscaled and composited **only inside the holes** — unlike
  the old pipeline the rest of the frame keeps splat resolution.
- `inpaint="none"`: raw warp straight to SBS — fastest, and a strong
  quality baseline.
- `inpaint="m2svid"` is **deprecated** (net-harmful per A/B test 1);
  it remains available on a fixed A100-80GB worker.

## Dual resolution (v7): depth_res / inpaint_res / output_res

The three pipeline resolutions are decoupled so the expensive
perceptual work runs cheap while the output stays high-res:

- **depth** at `depth_res` (alias of `input_size`),
- **inpaint** (ProPainter fill) at `inpaint_res` (short side, default 720),
- **splat + composite** at `output_res` (short side of the output).

Preprocess emits two surfaces from the same trim + fps decimation:
`work_path` (inpaint tier — depth and the fill read this) and
`splat_path` (output res). The forward-warp is a geometric pixel
shift, so splatting the full-res frame preserves output-res detail in
~95% of the frame; only the disocclusion holes carry
upscaled-from-inpaint-res fill. Dual-res only engages when
`inpaint_res` is given AND smaller than the output; otherwise
`splat_path` is None and the single-res path is byte-identical to
pre-v7. Frame counts of the two surfaces are identical by construction
(the A/V-sync invariant). Details, VRAM notes, and the GPU-verified
test matrix: `docs/V7_DUALRES_SPLAT.md`.

## Content-addressed reuse (`app/common/reuse.py`)

Preprocess results, depth maps, and scene-cut lists are cached by a
deterministic SHA-256 key over everything that affects the stage's
output, layered so downstream keys include upstream ones:

- `preprocess`: (input_path, remove_black_bars, output spec,
  target_fps, trim, crop_override) → the work file (+ splat file) is
  byte-identical for an identical key.
- `depth`: (preprocess_key, depth_model, input_size, encoder).
- `scenes`: (preprocess_key) — cached **inline** in the registry (tiny
  cut list, no GCS file).

The registry is a per-env Modal Dict (`stereo3d-reuse-<env>`) pointing
at published GCS artifacts (`outputs/<job>/preprocess.mp4`,
`depth.mp4`, …). `lookup()` verifies the GCS file still exists, so a
stale entry degrades to a recompute, never a wrong reuse. Per-stage
`skip_reuse_<stage>` flags bypass the cache; explicit
`reuse_depth_from` / `reuse_preprocess_from` (job id) win over
auto-reuse and work **cross-env** (they fetch by GCS path under the
shared prefix, no Dict read). `POST /v1/reuse/lookup` computes the
same keys for a would-be request and reports any cached artifacts —
including a ready-to-use `reuse_depth_from` job id — without
submitting a job.

## Black bars

Letterbox/pillarbox bars corrupt depth estimation and waste disparity
budget. Videos: ffmpeg `cropdetect` sampled at 3 points, conservative
(largest stable) crop, applied before depth. Images: tensor row/column
max-intensity threshold inside the image worker. Both report the crop
in job metadata.

## MV-HEVC spatial video for Apple Vision Pro

Implemented in `app/stages/mvhevc.py` with **two encoders** sharing the
same downstream chain (MP4Box mux → vexu/hfov injection → verification):

- **`encode_mvhevc_x265`** (default): CPU-only x265 multiview on a
  **32-core** container. x265 is the only Linux encoder whose VPS
  multiview signaling Apple's spatial classifier accepts — this is the
  path that earns the Photos/Files **spatial badge**. Single contiguous
  encode (can't fan out), ~36× realtime at 4K, 6h timeout ceiling.
- **`encode_mvhevc`** (`"mvhevc_encoder": "nvenc"`): NVENC on **L4**
  ($0.80/h — NVENC is fixed-function; bigger GPUs add nothing). Fast
  path; output plays in third-party AVP players but does NOT get the
  Apple spatial badge.

Both read the raw SBS master (`stereo["sbs_path"]`) directly, so they
compose with dual-res output (the SBS is already at output res). If the
request asks for **only** `mvhevc`, `encode_outputs` is skipped
entirely. Verified facts that shaped the NVENC path:

- NVENC MV-HEVC ships in Video Codec SDK 13.0, gated by a runtime cap,
  **not** by Blackwell. On Modal: L4 / L40S / A10G / T4 / RTX-PRO-6000
  have NVENC; **B200, H100/H200, A100 have none**.
- Must use the **ffmpeg n8.1 release build** — master builds target
  NVENC API 13.1, which needs driver ≥ 610; Modal hosts run 580.x.
- ffmpeg's MOV muxer silently **drops the second view** (verified), so
  the stage encodes a raw `.hevc` and muxes with **GPAC master
  MP4Box** (distro GPAC 1.0.1 writes no `lhvC` box — the layered
  config visionOS requires; master writes `hvcC`+`lhvC` correctly).
- Apple "spatial media" recognition needs `vexu` (eyes/stri/hero +
  cams/blin + cmfy/dadj) and `hfov` boxes inside the `hvc1` sample
  entry. `app/stages/vexu.py` builds them byte-exact per Apple's
  Stereo Video ISOBMFF Extensions spec (self-tested against reference
  hex); Bento4 `mp4edit` splices them and patches chunk offsets.
- Every run verifies: `lhvC`+`vexu`+`hfov` present (mp4dump) and the
  second view decodes — reported as `spatial_boxes_verified` /
  `two_views_verified`.

Defaults (request `spatial` object overrides): baseline 19.24 mm,
hfov 63.4°, disparity adjustment +0.02, hero=left — iPhone-15-Pro-like.

## Preemption tolerance

Modal preempts functions and retries them on the same input; a naive
monolithic stage would restart a long video from zero. Mitigations:

- **Segmented checkpoints**: video depth writes one file per scene
  (alignment resets at cuts anyway, so results are identical); the
  stereo pass writes ~240-frame segments aligned to ProPainter batch
  boundaries. Segments live in the cache volume (committed as they
  finish, plus an `@modal.exit` commit in the 30s preemption grace
  window); the retried call skips finished segments and the final
  output is a lossless ffmpeg concat.
- **Retries** on every worker (`modal.Retries` with backoff: GPU
  workers max_retries=2, CPU helpers max_retries=3). GPU workers are
  preemptible; combined with segment checkpoints a retried attempt
  skips finished work.
- **Non-preemptible orchestrators**: the pipeline coordinators
  (`process_video_job`, `process_image_job`) are tiny CPU containers;
  `nonpreemptible=True` costs 3× of almost nothing and keeps the
  conductor alive across the whole job.
- **Fan-out for long videos** (implemented): above `PARALLEL_THRESHOLD`
  (1500 frames, or explicit `"parallel"`) depth fans out scene-aligned
  chunks (≤1500 frames each) and stereo fans out segment-aligned chunks
  (≤1200 frames), capped at `max_gpu_workers` concurrent containers
  (default 4). Chunk boundaries land on segment boundaries, so fan-out
  output is byte-identical to sequential.

### Heartbeat watchdog (`app/common/watchdog.py`)

A GPU worker can hang *silently* — no exception, no progress — and
Modal's multi-hour function timeout won't catch it for ages. Fan-out
gathers go through `gather_with_heartbeat`: every chunk worker
heartbeats per batch via `jobs.report_progress`, which records a
chunk-local progress counter keyed by the chunk's first frame. The
watchdog judges each chunk on its **own** heartbeat (a slow batch on
another chunk can't mask a hang): a chunk silent for `stall_timeout_s`
(default `STALL_TIMEOUT_S = 240`, overridable per request) is
cancelled and **resubmitted on a fresh container** up to
`MAX_CHUNK_RETRIES = 2` times (per chunk) while healthy chunks keep
running; only exhausted retries fail the job. Queued-but-not-started
chunks get unbounded patience (their stale progress entry is cleared
on resubmit — this is what prevents the resubmit death-spiral), backed
by a job-wide wedged-pool backstop (`START_TIMEOUT_S = 1800`): if NO
chunk advances anywhere for that long, the job fails rather than
hanging forever. The clock/Dict reads are injectable seams, unit-tested
without Modal in `tests/test_watchdog_selfheal.py`.

## Per-function resources and timeouts

From the `@app.function` / `@app.cls` decorators (memory shown as
request→limit MiB); GPU classes use
`scaledown_window = SCALEDOWN_WINDOW = 30` s (`app/env.py`) — long
enough for a fan-out worker to stay warm for its next queued chunk,
short enough to keep idle GPU cost low.

| function / class | GPU | cpu | memory | timeout |
|---|---|---|---|---|
| `process_video_job` (orchestrator, nonpreemptible) | — | 2 | 1 GiB → 8 GiB | 8 h |
| `process_image_job` (orchestrator, nonpreemptible) | — | 1 | 512 MiB → 4 GiB | 2 h |
| `preprocess_video` | — | 4 | 2 → 16 GiB | 2 h |
| `detect_scenes` | — | 2 | 2 → 16 GiB | 2 h |
| `encode_outputs` (coordinator) | — | 1 | 512 MiB → 2 GiB | 3 h |
| `encode_one_format` | — | 4 | 2 → 16 GiB | 90 min |
| `concat_cache_segments` | — | 2 | 1 → 16 GiB | 2 h |
| `publish_file` / `fetch_preprocess_reuse` / `probe_depth_reuse` | — | 1 | 512 MiB → 8 GiB | 30 min |
| `VideoDepthWorker` (VDA) | L40S (→ H200/B200 via `with_options`) | 4 | 4 → 128 GiB | 2 h |
| `FrameDepthWorker` (DA2/DA3/Depth Pro) | L40S | 4 | 4 → 128 GiB | 4 h |
| `ShotProfiler` (adaptive) | L40S | 4 | 4 → 128 GiB | 10 min |
| `VideoStereoWorker` | L40S (→ H200 via `with_options`) | 4 | 4 → 128 GiB | 2 h |
| `M2SVidStereoWorker` (deprecated) | A100-80GB | 4 | 4 → 128 GiB | 2 h |
| `encode_mvhevc` (NVENC) | L4 | 4 | 2 → 16 GiB | 3 h |
| `encode_mvhevc_x265` | — | **32** | 8 → 32 GiB | 6 h |
| `ImageStereoWorker` | A10G | 2 | 2 → 32 GiB | 1 h |

## A/V sync guarantees

Frame loss anywhere in a distributed pipeline accumulates into
audible audio drift. Defenses, in order:

1. Decoding is index-based (torchcodec) and writers receive raw frame
   pipes — no timestamp-driven drops/dups.
2. The exact rational frame rate (`24000/1001`, not a float) threads
   from probe to every ffmpeg writer.
3. **Frame-count invariants**: depth and SBS outputs are packet-counted
   and must equal the source frame count — the segment concat and the
   orchestrator both refuse to continue on mismatch.
4. Audio is muxed once, at the very end, from the **pristine source**
   (the cropped work file is video-only by design).
5. `encode_outputs` measures the video-vs-audio duration delta per
   deliverable (`av_sync_ms` in job metadata) and warns above ~half a
   frame.

## Job lifecycle

`POST /v1/videos|images` → `jobs.create_job` (modal.Dict, 7-day TTL) →
`spawn` orchestrator → stages update status/progress/timings →
deliverables published under
`gs://spatial-video-studio-app/stereo3d/<env>/outputs/<job_id>/` with
public URLs in `outputs`. Stage endpoints spawn workers directly; the
status endpoint reconciles their FunctionCall results lazily.
