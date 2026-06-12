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
| video depth | `video_depth_image` | L40S | VideoDepthAnything vitl at input_size ≤ ~1148 fits 48 GB; A100-80GB only needed for ≥1204 |
| video stereo (splat + ProPainter) | `stereo_image` | L40S | RAFT/ProPainter run at a bounded work resolution (default 1280×720) |
| image pipeline | `image_stereo_image` | A10G | DA2-Large fp16 + LAMA fit comfortably; cheapest adequate GPU |

GPU concurrency is bounded by the workspace limit (10 GPU containers).
Stages are separate Modal functions, so a long video can have depth and
stereo running on different containers across jobs, but within one job
stages are sequential (stereo needs depth).

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
  propagation → sparse transformer) at a working resolution
  (default 1280×720). The fill is upscaled and composited **only inside
  the holes** — unlike the old pipeline the rest of the frame keeps
  source resolution.
- `inpaint="none"`: raw warp straight to SBS — fastest, and a strong
  quality baseline.

## Black bars

Letterbox/pillarbox bars corrupt depth estimation and waste disparity
budget. Videos: ffmpeg `cropdetect` sampled at 3 points, conservative
(largest stable) crop, applied before depth. Images: tensor row/column
max-intensity threshold inside the image worker. Both report the crop
in job metadata.

## MV-HEVC spatial video for Apple Vision Pro

Implemented in `app/stages/mvhevc.py` on **L4** ($0.80/h — NVENC is
fixed-function; bigger GPUs add nothing). Verified facts that shaped it:

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
- **Retries** on every worker (`modal.Retries`, 3 attempts, backoff).
- **Non-preemptible orchestrators**: the pipeline coordinators are
  tiny CPU containers; `nonpreemptible=True` costs 3× of almost
  nothing and keeps the conductor alive across the whole job.
- Scale-out for very long videos (segment fan-out over multiple GPU
  containers in parallel, scene-aligned) is the natural next step —
  the segment files and manifest layout already support it.

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
