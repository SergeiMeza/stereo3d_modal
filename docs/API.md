# API reference

Base URL (test): `https://stereo-crafter-test--stereo3d-api-test.modal.run`

All bodies are JSON. Input paths are bucket-relative
(`inputs/samples/videos/clip_1s_480p.mp4`) or full
`gs://spatial-video-studio-app/stereo3d/<env>/...` URIs.
Outputs are public `storage.googleapis.com` URLs.

Job tracking uses **custom job ids** stored in a `modal.Dict`
(~7-day retention) — never Modal function-call ids, whose history
expires after a day. Poll `GET /v1/jobs/{job_id}`.

## Production endpoints

### POST /v1/videos — full video pipeline

```jsonc
{
  "input_path": "inputs/samples/videos/clip_10s_scenes_1080p.mp4",  // required
  "displacement": 0.0125,        // max disparity, fraction of width (0, 0.1]
  "inpaint": "propainter",       // "propainter" (best) | "none" (raw warp, fastest)
  "input_size": 980,             // depth resolution, multiple of 14; ≤1148 fits L40S
  "encoder": "vitl",             // "vitl" | "vits"
  "remove_black_bars": true,
  "formats": ["sbs", "half_sbs", "tb", "half_tb", "anaglyph", "mvhevc"],
  "include_audio": true,
  "output_depth": true,          // also publish the gray16 depth video
  "spatial": {                   // Apple spatial metadata (mvhevc format)
    "hero": "left",              // "left" | "right" | null
    "baseline_mm": 19.24,        // virtual camera baseline
    "hfov_deg": 63.4,            // horizontal field of view
    "dadj": 200                  // disparity adjustment, ±10000 = ±100%
  }
}
```

The `mvhevc` format produces an Apple Vision Pro **spatial video**
.mov: NVENC MV-HEVC on L4 → MP4Box mux (hvcC+lhvC) → vexu/hfov
injection. The job result reports `two_views_verified` and
`spatial_boxes_verified`.

→ `{"job_id": "...", "status": "pending", "status_url": "/v1/jobs/..."}`

### POST /v1/images — image pipeline (single or batch)

```jsonc
{
  // batch form:
  "items": [
    {"input_path": "inputs/samples/images/004_qO-PIF84Vxg.jpg",
     "item_id": "pup4",            // optional, defaults to filename stem
     "displacement": 0.01,
     "stereo_mode": "both"}        // "both" | "left" | "right"
  ],
  // or single-image shorthand: "input_path": "inputs/samples/images/x.jpg",
  "formats": ["lr", "tb", "half_lr", "half_tb", "anaglyph"],
  "output_depthmap": true,
  "remove_black_bars": true
}
```

### GET /v1/jobs/{job_id}

```jsonc
{
  "job_id": "…", "kind": "video", "status": "in_progress",  // pending|in_progress|completed|failed
  "stage": "video_depth", "progress": 0.62,
  "progress_detail": {            // client-app progress, updated every ~30 frames / 5s
    "stage": "video_stereo[propainter]",
    "done": 90, "total": 240, "unit": "frames",
    "rate_per_s": 0.7, "eta_seconds": 210
  },
  "outputs": {"sbs": "https://…", "anaglyph": "https://…", "depth": "https://…"},
  "timings": [   // per-stage benchmark records
    {"stage": "preprocess", "seconds": 4.1, "gpu": null, "detail": {"crop": "3840:1664:0:248"}},
    {"stage": "video_depth", "seconds": 63.0, "gpu": "L40S", "detail": {"input_size": 980}}
  ],
  "metadata": {"probe": {…}, "crop": null, "scene_cuts": [27, 58]},
  "error": null
}
```

### DELETE /v1/jobs/{job_id} — cancel a pending/running job

## Experimental stage endpoints

Test pipeline segments in isolation. Same submit/poll shape; results
appear in the job's `result` field.

| Endpoint | Body | Does |
|---|---|---|
| `POST /v1/stages/video-depth` | `{input_path, input_size?, encoder?}` | depth video only (cache path + scene cuts) |
| `POST /v1/stages/video-stereo` | `{video_path, depth_path, displacement?, inpaint?}` | splat+inpaint from an existing depth video (cache paths from a previous stage) |
| `POST /v1/stages/encode-mvhevc` | `{sbs_path, quality?, spatial?}` | spatial MV-HEVC .mov from an existing SBS master |
| `POST /v1/stages/scene-detect` | `{input_path}` | scene cut list |
| `POST /v1/stages/crop-detect` | `{input_path}` | black-bar geometry + cropped copy in cache |

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
print(s["outputs"])
```
