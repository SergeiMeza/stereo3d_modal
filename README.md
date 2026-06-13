# stereo3d — 2D → stereo 3D conversion on Modal

Converts 2D images and videos into stereo 3D (SBS, top-bottom,
anaglyph, depth maps) using depth estimation + forward-warp splatting +
inpainting. Successor to `2d_to_3d/onnx-depth-anything`, rebuilt on
Modal 1.2.x with lessons from `ml-sharp-modal`.

## Quick start

```bash
modal profile activate stereo-crafter-test

# one-time: push sample inputs to GCS
modal run scripts/upload_samples.py

# deploy
modal deploy -m app.main

# smoke-test the deployment
python scripts/smoke_test.py --base-url https://stereo-crafter-test--stereo3d-api-test.modal.run

# full benchmark matrix (writes docs/BENCHMARKS.md)
python scripts/benchmark.py --base-url https://stereo-crafter-test--stereo3d-api-test.modal.run
```

## API in 30 seconds

```bash
BASE=https://stereo-crafter-test--stereo3d-api-test.modal.run

# full video pipeline
curl -X POST $BASE/v1/videos -H 'content-type: application/json' -d '{
  "input_path": "inputs/samples/videos/clip_10s_scenes_1080p.mp4",
  "inpaint": "propainter",
  "formats": ["sbs", "half_sbs", "anaglyph"]
}'
# → {"job_id": "...", "status_url": "/v1/jobs/..."}

curl $BASE/v1/jobs/<job_id>     # status, outputs (public URLs), per-stage timings
```

Full reference: [docs/API.md](docs/API.md). Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Pipeline

```
video:  preprocess (CPU: probe + black-bar crop)
        → video depth   (GPU L40S: VideoDepthAnything v3, scene-aware streaming)
        → video stereo  (GPU L40S: Forward-Warp splat + ProPainter inpaint)
        → encode        (CPU: SBS master → half-SBS / TB / anaglyph + audio mux)

image:  one A10G container: black-bar crop → Depth-Anything-V2-Large
        → Forward-Warp splat → LAMA inpaint → formats
```

Models migrated from the old project (latest variants):
- **video_depth_v3** / VideoDepthAnything (vitl/vits) with the
  scene-aware `DepthProcessor` (32-frame windows, 10-frame overlap,
  scale/shift alignment, cuts reset alignment)
- **Depth-Anything-V2-Large** (TorchScript fp16) for stills
- **ProPainter** for video inpainting, **LAMA** for image inpainting
- **Forward-Warp** CUDA splatting — raw warp, no blurs/masks
  (`"inpaint": "none"` gives the pure-warp output)

> **Inpainter decision (2026-06-13, device-confirmed): ProPainter is
> the default and preferred backend.** Headset comparison on the 60s
> dance + letterbox clips (ProPainter vs M2SVid, identical depth via
> `reuse_depth_from` so only the fill differs) — ProPainter produces
> better results overall: cleaner silhouettes and fewer disocclusion
> artifacts. M2SVid (`"inpaint": "m2svid"`) stays available for
> reference (and is ~3–4× faster) but shows white edge-fuzz on
> high-contrast disocclusion stripes. **Skip M2SVid for new experiments
> — use ProPainter.**

## Layout

```
app/
  main.py          deployment entrypoint (modal deploy -m app.main)
  env.py           APP_ENV (test|prod) → app/endpoint names
  modal_app.py     the shared modal.App
  api/             FastAPI app (plain-JSON contracts, no Pydantic validation)
  pipelines/       CPU orchestrators (video, image)
  stages/          workers: media (CPU), video_depth, video_stereo, image_stereo (GPU)
  images/          per-stage Modal images (stable layers first)
  common/          storage (GCS+volumes), jobs (modal.Dict), weights, debug
  vendor/          vendored model code (VideoDepthAnything, ProPainter, Forward-Warp)
samples/           test inputs (1s / 10s-with-scene-cuts clips at 480p–2160p,
                   letterboxed clips, 5 photos + letterboxed frame)
scripts/           upload_samples, smoke_test, benchmark
docs/              API.md, ARCHITECTURE.md, BENCHMARKS.md (generated)
```

## Storage

| What | Where |
|---|---|
| Inputs/outputs | `gs://spatial-video-studio-app/stereo3d/<env>/…` (HMAC `gcp-secret`); mount restricted by `key_prefix` |
| Intermediates | Modal Volume `stereo3d-cache-<env>` at `/cache` |
| Model weights | Modal Volume `stereo3d-weights` at `/weights` — downloaded on first use, survive image rebuilds |

## Notes

- **GPU budget:** workers cap at fixed GPU types (L40S / A10G); the
  workspace limit is 10 concurrent GPU containers.
- **Memory:** depth+stereo stages stream frames through generators and
  ffmpeg pipes; long 4K clips stay bounded.
- **Apple spatial video (device-verified):** the `mvhevc` format makes
  Photos/Files-recognized spatial .movs entirely in the cloud — x265
  multiview (CPU) + MP4Box + byte-exact vexu/hfov injection. NVENC (L4)
  remains as the fast MV-HEVC path for custom players. Details + the
  long elimination story: docs/ARCHITECTURE.md.
- **Long videos:** depth and stereo fan out across up to
  `max_gpu_workers` GPU containers (auto >1500 frames, or force with
  `"parallel": true`) with resumable segment checkpoints. Chunk size is
  **capped** (not divided by a fixed worker count), so a worker's wall
  time never grows with video length — long clips spawn *more* chunks
  (`STEREO_CHUNK_FRAMES=1200`, `DEPTH_CHUNK_FRAMES=1500`), bounded to
  `max_gpu_workers` concurrent via `max_containers`. Adaptive depth
  scripts fan out too (they key on absolute frame index). Raising
  `max_gpu_workers` toward the workspace ceiling scales throughput.
- **Presets:** `draft` / `1080p` / `qhd` / `3k` / `4k` bundle target
  resolution, depth input_size, inpainting work res, and (via routing)
  GPU tier.

## Timeouts

Sized so **expensive long-video work is never dropped mid-flight**. Two
rules: (1) per-worker timeouts cover a *bounded* unit (a fan-out chunk,
or a ≤1500-frame no-fan-out clip) plus model cold-load; (2) the
orchestrator and the un-parallelizable single-pass stages cover the
worst-case *whole-video* runtime.

| Function | Timeout | Why |
|---|---|---|
| `process_video_job` (orchestrator) | **8h** | Blocks on the SUM of all stages; must outlive the slowest end-to-end run. Cheap idle CPU container. |
| `VideoStereoWorker` (ProPainter) | 2h | Chunk ≤1200f ≈ 33 min @ 0.6 fps; covers a no-fan-out clip + model load. |
| `M2SVidStereoWorker` | 2h | Fast (~6 fps) but covers no-fan-out clip + diffusion cold-load. |
| `VideoDepthWorker` (VDA) | 2h | Chunk ≤3000f ≈ 5 min @ 11 fps; wide margin. |
| `FrameDepthWorker` (DA3 / Depth Pro) | **4h** | **Cannot fan out** — needs one job-wide p1/p99 metric pass. ~2 fps → a 10-min clip ≈ 2h. Production depth is VDA; this guards experiments + the adaptive profiler. |
| `encode_mvhevc_x265` | **6h** | Single CPU encode, can't fan out: ~36× realtime @ 4K (≈3h for 5 min). |
| `encode_mvhevc` (NVENC) | 3h | GPU-accelerated; generous for long clips. |
| `encode_outputs` | 3h | Per-format encodes (libx264 SBS etc.), scale with length. |
| `preprocess_video` | 2h | Decode + crop + rescale whole source. |
| `detect_scenes` | 2h | Full-video PySceneDetect scan. |
| `concat_cache_segments` | 2h | Lossless stream-copy of fan-out segments. |
| `publish_file` / `probe_depth_reuse` | 30 min | Byte copies of (possibly multi-GB 4K) files. |
| `web_app` (API endpoints) | 5 min | Submit/poll only — real work runs async. |

`SCALEDOWN_WINDOW` (`app/env.py`): 300s prod / 30s non-prod — idle
container linger, unrelated to job timeouts. `nonpreemptible=True` on
the CPU orchestrator so a preemption never kills the coordinator
holding a multi-hour job together. **If you change a backend's
throughput or add a stage, re-check the bounded-chunk math here.**
