# Adaptive Per-Shot Depth Script (v1 + pro treatment v2)

The adaptive pipeline (`"adaptive": true` on a video job) replaces the single
job-wide `displacement`/`placement` with a per-shot "depth script": scenes are
detected, profiled with `da3-metric`, and graded like a stereographer would
grade a conversion. Code: `FrameDepthWorker.profile_scenes` +
`_build_depth_script` in `app/stages/video_depth_models.py` (pure python,
testable offline); consumed per frame via `_scene_param_lookup` in
`app/stages/video_stereo.py`.

## Profiling (v1)

Per scene, 3 keyframes (first / middle / last) are inferred with DA3METRIC.
All keyframe disparities (`1/depth`) are pooled and the job-wide p1/p99 range
`(lo, hi)` defines normalized disparity `nd = clip((d − lo)/(hi − lo), 0, 1)`.
Per keyframe we keep: median raw depth, median raw disparity, and
`near_fraction` (pixel fraction with `nd > PROFILE_NEAR_BAND = 0.75`).

## Classification & SHOT_PARAMS

Tested in order (constants `PROFILE_*`):

- **dynamic** — keyframes disagree: spread of per-keyframe median `nd` > 0.30
  or of `near_fraction` > 0.25. Scene-level averages can't be trusted.
- **close_up** — median depth < 1.5 (raw units ≈ 3 m at 50° HFOV) OR
  `near_fraction` > 0.35. Small displacement, pop-out capped at 0.1: a face
  filling the frame at full budget strains the eyes and violates the window.
- **wide** — median depth > 6.0 AND `near_fraction` < 0.10. Largest
  displacement, everything at/behind the screen: distant content needs more
  disparity to read as deep.
- **standard** — the pipeline defaults (`0.0125`, `(-1.0, 0.5)`).

`disp_map = depthmap × (placement[1] − placement[0]) + placement[0]`, scaled by
`displacement × width` (halved in "both" mode) — see `app/stages/splat.py`.

## v2 mechanism 1 — depth-matched cuts

The viewer's eyes must not be yanked across a cut: the SALIENT content (median
depth, where they're looking) should land at a similar screen disparity on
both sides. Salient screen disparity at a boundary:

    screen_disp = displacement × (nd × (placement[1] − placement[0]) + placement[0])

with `nd` = median normalized disparity of the outgoing shot's LAST keyframe /
incoming shot's FIRST keyframe. Forward pass over cuts (after the v1
adjacent-shot displacement clamp of ±`PROFILE_MAX_DISPLACEMENT_STEP = 0.005`):
if `|jump| = |screen_disp_in − screen_disp_out| > CUT_DISPARITY_TOLERANCE =
0.002`, the incoming shot's placement is shifted uniformly by
`−(jump − sign(jump)·tol)/displacement_in`, leaving a residual jump equal to
the tolerance. Shifts are clamped to `placement[0] ≥ −1.3`, `placement[1] ≤
0.6` (logged when the clamp prevents full correction). Only placement moves —
displacement continuity stays with the v1 clamp.

## v2 mechanism 2 — comfort budget (applied last)

Per shot AND per keyframe:

- background divergence `displacement × |min(placement[0], 0)| ≤ 0.02` of
  width (≈ broadcast divergence limit),
- pop-out `displacement × max(placement[1], 0) ≤ 0.008`.

Violations scale **displacement** down (never placement — that would un-match
the cut). Known interaction: scaling after matching changes `screen_disp`
linearly, so a capped boundary can exceed the cut tolerance again — accepted
for v2 and recorded in `adjustments`.

## v2 mechanism 3 — intra-shot ramps (dynamic shots)

Each of a dynamic shot's keyframes is classified alone (no spread checks →
close_up / wide / standard) and its `SHOT_PARAMS` emitted as
`"keyframes": [{"index", "displacement", "placement"}, ...]`. The shot's
top-level params remain the dynamic compromise for consumers that ignore
keyframes. Cut-matching targets the boundary keyframes; the comfort budget
applies per keyframe. `_scene_param_lookup` linearly interpolates displacement
and each placement component between bracketing keyframes (clamped outside the
keyframe range), so the grade ramps instead of compromising.

## Script entry

`{"first", "last", "shot_type", "displacement", "placement", "median",
"near_fraction", "screen_disp_in", "screen_disp_out"}` plus optional
`"keyframes"` and `"adjustments"` (human-readable strings, also jlogged 🎛).

## Known limitations

- **3-keyframe sampling** — motion between keyframes is invisible; a brief
  insert can be misclassified.
- **FOV-dependent thresholds** — `da3-metric` is focal-normalized; the
  absolute close/wide cuts assume ~50° HFOV. `near_fraction` is
  focal-invariant and carries most of the weight.
- **Displacement scaling after matching** — see comfort budget above.
- **No floating windows yet** — window violations on pop-out at frame edges
  are not masked.
- **ProPainter batches straddling cuts** — a batch can mix two disparity
  regimes; per-frame lookup is correct but the inpainting window sees both.

## Planned v3

Per-scene `fov_deg` from the Depth Pro backend (branch `depth-pro-backend`)
will replace the focal-unknown heuristics with true metric distances, making
the close/wide thresholds camera-independent. Not implemented.
