# Full-batch v2 — fast multi-GPU run + tuned shot params

All: v3 path (depth-pro profiler, VDA depth), qhd/1440p, ProPainter, auto_comfort on,
adaptive keyframe sampling, **tuned A+B shot params** (wide ramped DOWN + behind screen).
Fast fan-out: max_gpu_workers=14, stereo_chunk=400, depth_chunk=500.

| video | job | status | shots | classes | total time |
|---|---|---|---|---|---|
| dance_full_v2 | 9b8755a938c6 | completed | 68 | {'wide': 22, 'standard': 38, 'dynamic': 8} | 128.3 min |
| webm2_full_v2 | 01afb4997eb2 | failed | 0 | {} | 43.7 min |
| K9_full_v2 | d9ac72b5bed4 | failed | 0 | {} | 184.2 min |
| awkky_full_v2 | d1b7ba2c02b5 | failed | 0 | {} | 68.9 min |

Per-video `.yaml` files carry the full classifier decisions (per-shot class, displacement,
placement, median depth in meters, FOV, salient screen disparity) + the tuning context.
`*_depth_script.json` is the raw per-shot script for tooling.
