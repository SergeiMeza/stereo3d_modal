# Adaptive Per-Shot Depth Script (v1 + pro treatment v2 + FOV-informed v3)

The adaptive pipeline (`"adaptive": true` on a video job) replaces the single
job-wide `displacement`/`placement` with a per-shot "depth script": scenes are
detected, profiled with the `"profiler"` model (`da3-metric` default,
`depth-pro` for v3), and graded like a stereographer would grade a conversion.
Code: `FrameDepthWorker.profile_scenes` + `_build_depth_script` in
`app/stages/video_depth_models.py` (pure python, testable offline); consumed
per frame via `_scene_param_lookup` in `app/stages/video_stereo.py`.

## Profiling (v1)

Per scene, 3 keyframes (first / middle / last) are inferred with the profiler
model (DA3METRIC by default).
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

## v3 — FOV-informed profiling (Depth Pro)

`"profiler": "depth-pro"` (only with `adaptive: true`; default stays
`da3-metric` and is byte-identical to v2) switches the profiling backend to
Apple Depth Pro, which returns TRUE metric depth in meters (its own per-frame
focal estimate is folded in — no focal normalization) plus a per-frame
horizontal FOV, `fov = 2·atan(W/(2·f_px))`.

**Meters thresholds** (`units="meters"` in `_build_depth_script`): the tight
absolute cuts `PROFILE_CLOSE_MEDIAN_M = 3.0` (median subject within 3 m →
close-up) and `PROFILE_WIDE_MEDIAN_M = 11.0` (beyond 11 m → wide) REPLACE the
loose focal-unknown da3-metric heuristics (1.5 / 6.0 raw units, which only
approximate 3 m / 11 m at an assumed ~50° HFOV). `near_fraction` and the
spread-based dynamic test are scale-invariant (measured against the job's own
pooled disparity range) and stay unchanged.

**FOV modifier** (shot-mean over the keyframes, applied after the dynamic and
base close-up tests, before the base wide test):

- long lens: `fov < 30°` AND `median < 5 m` → bias to **close_up** — portrait
  compression reads as close even past the 3 m cut;
- wide-angle lens: `fov > 60°` AND `median > 8 m` AND `near_fraction < 0.10`
  → bias to **wide**.

Precedence stays dynamic-first. Dynamic keyframe ramps classify each keyframe
with the same units and shot-mean FOV (lens character is a per-shot
property). Script entries gain `"fov_deg"` (shot mean, 1 dp) when available;
all v2 mechanisms (cut matching, comfort budget, ramps) operate on normalized
disparity downstream of classification and are unit-agnostic.

**Cost**: profiling adds ~0.3 s/keyframe × 3 keyframes × scenes of Depth Pro
inference — trivial next to the main depth pass — but loading Depth Pro adds
container cold-start time versus reusing a warm da3-metric profiler.

## Auto-comfort

`"auto_comfort": true` (default; `adaptive: true` only) picks the per-job
displacement scale automatically instead of making the user guess `depth_scale`.
The profiler builds the script once at scale 1.0, measures the **p95** of
`|screen_disp_in| / |screen_disp_out|` across all shots, and compares it to
`comfort_budget` (default `0.02` = the broadcast background-divergence bracket,
i.e. `MAX_BACKGROUND_DISPARITY`; request override range `(0, 0.05]`):

    scale = clamp(comfort_budget / measured_p95, 0.3, 1.0)

p95 (not max) so a single outlier shot can't crush the whole video — with few
shots p95 ≈ max anyway. It only ever tones **down**: `>1.0` is capped at 1.0, so
a quiet clip is never pushed past the artistic default; `measured == 0`
(degenerate) → 1.0. When the chosen scale < 1.0 the script is **rebuilt** at
that scale (not post-multiplied) so depth-matched-cut placement shifts, the v1
step clamp, and the comfort budget all recompute proportionally. The chosen
scale is logged (🎛 `auto_comfort: ...`) and surfaced in job
`metadata["comfort_scale"]`.

**Precedence**: an explicit `depth_scale != 1.0` is a manual override and WINS —
auto-comfort is skipped entirely (logged). `auto_comfort: false` → scale stays
at `depth_scale` (1.0 default) unconditionally.

Auto-comfort is **complementary to v3**: v3 fixes classification at the source
(true meters + FOV), while auto-comfort is a safety clamp on the resulting
disparities. Pure helpers `_auto_comfort_scale(script, comfort_budget)` and
`_apply_auto_comfort(...) -> (script, applied_scale)` live at module level and
are offline-testable.

## Script entry

`{"first", "last", "shot_type", "displacement", "placement", "median",
"near_fraction", "screen_disp_in", "screen_disp_out"}` plus optional
`"fov_deg"` (depth-pro profiler, shot mean, 1 dp), `"keyframes"` and
`"adjustments"` (human-readable strings, also jlogged 🎛).

## Known limitations

- **3-keyframe sampling** — motion between keyframes is invisible; a brief
  insert can be misclassified.
- **FOV-dependent thresholds (da3-metric profiler)** — `da3-metric` is
  focal-normalized; the absolute close/wide cuts assume ~50° HFOV.
  `near_fraction` is focal-invariant and carries most of the weight. Solved by
  the v3 `depth-pro` profiler (true meters + FOV modifier).
- **Displacement scaling after matching** — see comfort budget above.
- **No floating windows yet** — window violations on pop-out at frame edges
  are not masked.
- **ProPainter batches straddling cuts** — a batch can mix two disparity
  regimes; per-frame lookup is correct but the inpainting window sees both.

- **Depth Pro weights are research-only** (apple-amlr license) — the v3
  profiler is R&D only, like the `depth-pro` depth backend.
