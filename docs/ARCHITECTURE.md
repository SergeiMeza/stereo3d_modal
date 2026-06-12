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

## MV-HEVC for Apple Vision Pro (experimental, planned)

Research conclusions (June 2026):

- NVENC MV-HEVC ships in Video Codec SDK 13.0, gated by the runtime cap
  `NV_ENC_CAPS_SUPPORT_MVHEVC_ENCODE`, **not** by Blackwell.
  On Modal: L4 / L40S / A10G / T4 / RTX-PRO-6000 have NVENC;
  **B200, H100/H200, A100 have none.**
- ffmpeg ≥ 8.0 encodes it natively: `-c:v hevc_nvenc -profile:v mv`
  with `framepack=frameseq` input (driver ≥ 570 — satisfied on Modal).
- ffmpeg's MP4 muxer can't write the layered boxes yet → mux the raw
  `.hevc` with GPAC `MP4Box`, retag `hvc1`.
- "Spatial" recognition on Vision Pro additionally needs `vexu`
  metadata; on Linux, splice prebuilt atoms with Bento4 `mp4edit`
  (or run Mike Swanson's `spatial` CLI on a Mac as a final pass).
- Fallbacks: NVIDIA `AppEncCuda` sample / PyNvVideoCodec; CPU x265 4.x
  `ENABLE_MULTIVIEW`; visionOS 26 APMP frame-packed SBS.

Plan: an `nvenc_image` (BtbN ffmpeg-8 static build + gpac + bento4) and
an `encode-mvhevc` stage on **L4**, consuming the SBS master. First step
is a 10-frame cap probe per GPU type.

## Job lifecycle

`POST /v1/videos|images` → `jobs.create_job` (modal.Dict, 7-day TTL) →
`spawn` orchestrator → stages update status/progress/timings →
deliverables published under
`gs://spatial-video-studio-app/stereo3d/<env>/outputs/<job_id>/` with
public URLs in `outputs`. Stage endpoints spawn workers directly; the
status endpoint reconciles their FunctionCall results lazily.
