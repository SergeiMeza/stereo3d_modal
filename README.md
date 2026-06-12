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
- **MV-HEVC (Vision Pro):** ffmpeg 8 `hevc_nvenc -profile:v mv` works on
  Ada GPUs (L4/L40S) — *not* Blackwell-only; B200/H100/A100 have no
  NVENC. Experimental stage tracked in docs/ARCHITECTURE.md.
