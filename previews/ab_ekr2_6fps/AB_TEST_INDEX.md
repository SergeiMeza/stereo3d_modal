# A/B Test — ekr2 first 60s @ 6fps

Same source (ekr2nIex040, 4K), trim 0–60s, **6fps** (≈5.994, every 4th
frame of 23.976), depth @ 1148 (1440p tier), audio kept. Run on
stereo-crafter-test. (2)/(3) REUSED (1)'s preprocess + depth + 4K splat
cache (auto-reuse, no job id) — only the inpaint fill differed.

Each variant has **MV-HEVC (spatial)** + **SBS** outputs.

| #   | inpaint                  | output | SBS dims  | MV-HEVC/eye | job          |
| --- | ------------------------ | ------ | --------- | ----------- | ------------ |
| 0a  | (none, local ffmpeg ref) | 1440p  | 2560x1440 | —           | local        |
| 0b  | (none, local ffmpeg ref) | 4K     | 3840x2160 | —           | local        |
| 1a  | none (raw warp)          | 1440p  | 5120x1440 | 2560x1440   | 7626d840c948 |
| 1b  | none (raw warp)          | 4K     | 7680x2160 | 3840x2160   | b2a9ee3c7621 |
| 2a  | **m2svid** @720          | 1440p  | 5120x1440 | 2560x1440   | 9c0baf40da26 |
| 2b  | **m2svid** @720          | 4K     | 7680x2160 | 3840x2160   | 2bc70111d6cf |
| 3a  | **propainter** @720      | 1440p  | 5120x1440 | 2560x1440   | e2fbce692356 |
| 3b  | **propainter** @720      | 4K     | 7680x2160 | 3840x2160   | d7aab465cd17 |

All: 360 frames @ 6fps, AAC stereo audio.

## What to compare

- **(1) vs (2) vs (3)** at the same resolution = the inpainter A/B (none /
  m2svid / propainter) on identical geometry. The disocclusion holes are
  where they differ: (1) leaves raw warp gaps, (2) M2SVid diffusion fill,
  (3) ProPainter flow fill.
- **1440p vs 4K** within each = the dual-res splat benefit (4K = sharper
  real detail; holes filled at 720 either way).

## Notes

- Auto-reuse verified: all 4 of (2)/(3) hit preprocess + scenes + depth
  reuse from (1), skipping the depth pass (~4x faster).
- 2b (M2SVid @ 4K) was the previously-untested dual-res path — completed
  with no OOM.

## File naming

`{variant}_{model}_{res}_{format}.{ext}` — e.g. `3b_propainter_4k_mvhevc.mov`.
