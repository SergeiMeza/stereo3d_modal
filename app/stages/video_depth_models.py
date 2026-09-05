"""Per-frame video depth worker (GPU).

Runs single-image depth backends over every frame of a video and
writes the SAME output contract as VideoDepthWorker.generate: a
gray16le H.264 depth video at the model's working resolution (larger
value = closer, i.e. disparity convention), plus frame count / fps /
shape / scene-cut metadata.

Backends (request field ``depth_model``):

- ``da2-metric-indoor`` / ``da2-metric-outdoor`` — Depth-Anything-V2
  metric fine-tunes (Hypersim / VKITTI) via transformers; output is
  absolute depth in meters (sigmoid * max_depth: 20 m / 80 m).
- ``da3`` — Depth Anything 3 DA3MONO-LARGE; output is scale-free
  relative DEPTH (not disparity).
- ``da3-metric`` — DA3METRIC-LARGE; output is focal-normalized metric
  depth (meters = focal_px * output / 300). The focal factor is
  unknown for arbitrary footage but constant per video, and a constant
  scale cancels under the normalization below.
- ``depth-pro`` — Apple Depth Pro (R&D ONLY: the weights are
  apple-amlr, research use only — see ensure_depth_pro); output is
  absolute metric depth in meters (canonical inverse depth scaled by
  the model's own focal-length estimate). Uniquely it also estimates
  a per-frame focal length / horizontal field of view; per-scene mean
  FOVs are returned under an additive ``fov_deg`` key for shot-type
  classification.

Unlike VideoDepthAnything there is no temporal window or cross-window
alignment — every frame is independent — so temporal coherence comes
entirely from the normalization policy:

- RELATIVE models: each frame's scale is only meaningful within the
  model's own output, so disparity ``d = 1 / max(depth, eps)`` is
  min-max normalized to [0, 1] over each SCENE (mirroring the VDA
  path's per-scene normalization); scene cuts reset the mapping so
  depth never bleeds across a cut.
- METRIC models: depth is converted to disparity ``d = 1 / max(depth,
  eps)`` and mapped through one JOB-WIDE affine range estimated up
  front from sampled frames:

      norm(d) = clip((d - p1) / (p99 - p1), 0, 1)

  where p1/p99 are the 1st/99th disparity percentiles over ~32 frames
  sampled uniformly across the whole video. A single global mapping
  means a given physical distance gets the same gray value in every
  scene — the cross-scene consistency that is the point of metric mode
  (percentiles, rather than min/max, so a few outlier pixels such as
  specular highlights cannot compress the usable range; ``eps`` only
  guards the division).

Checkpointing mirrors video_depth.py: one segment file per scene,
skipped if already complete on a retried call, lossless concat, and
the frame-count invariant enforced before returning.
"""

import json
import time
from pathlib import Path

import modal

from app.common import jobs
from app.common.errors import fail_fast
from app.common.debug import get_logger, job_logger, track
from app.common.ffmpeg_utils import concat_segments, count_frames
from app.common.storage import GPU_VOLUMES, cache_volume, hf_secret, slack_secret, job_cache_dir, safe_reload
from app.env import SCALEDOWN_WINDOW
from app.images import depth_models_image
from app.modal_app import app

logger = get_logger(__name__)

FRAME_DEPTH_GPU = "L40S"

# Request enum (api/main.py validates against this; "vda" routes to the
# original VideoDepthWorker and never reaches this module).
# exposed in the API; DA2-metric variants stay dormant (indoor/outdoor
# checkpoint split makes them operationally clumsy — user decision) but
# the loader still understands them for experiments
DEPTH_MODELS = ("da2", "da3", "da3-metric", "depth-pro")
METRIC_MODELS = ("da2-metric-indoor", "da2-metric-outdoor", "da3-metric", "depth-pro")
# Models whose raw output is already DISPARITY (near = large): the
# normalization must NOT take the reciprocal. Relative DA2 predicts
# disparity; DA3 predicts relative depth; metric models predict depth.
# Getting this wrong produces plausible-looking INVERTED stereo.
DISPARITY_MODELS = ("da2",)
# Adaptive profiling backends exposed via the "profiler" request field
# (api/main.py validates; both metric): "da3-metric" is the default,
# "depth-pro" (v3) profiles in true meters and adds the FOV modifier.
PROFILER_MODELS = ("da3-metric", "depth-pro")

# Frames sampled for the job-wide disparity range (metric models).
RANGE_SAMPLE_FRAMES = 32
# Depth floor before inversion — guards 1/0 only; the percentile (or
# per-scene min-max) mapping handles outliers.
DEPTH_EPS = 1e-4

# ------------------------------------------- adaptive shot profiling
#
# Threshold calibration (da3-metric, focal-normalized scale):
# DA3METRIC outputs depth with ``meters = focal_px * output / 300``,
# i.e. ``output = 300 * meters / focal_px``. At the 518-px profiling
# resolution a typical ~50° HFOV camera has focal_px ≈ 550, so
# ``output ≈ 0.55 × meters``. The absolute thresholds below are
# therefore read as: 1.5 ≈ scene median within ~3 m (close-up framing),
# 6.0 ≈ scene median beyond ~11 m (wide / establishing shot). Because
# the true focal is unknown for arbitrary footage, these absolute cuts
# are intentionally loose, and the focal-invariant ``near_fraction``
# (measured against the job's OWN pooled disparity range, so a constant
# focal scale cancels) carries most of the decision weight: it is OR'd
# in for close-ups and AND'd in for wides.
PROFILE_CLOSE_MEDIAN = 1.5  # raw da3-metric units (~3 m at 50° HFOV)
PROFILE_WIDE_MEDIAN = 6.0   # raw da3-metric units (~11 m at 50° HFOV)
#
# v3 (profiler="depth-pro", units="meters"): Depth Pro returns TRUE
# metric depth in meters (its own focal estimate is folded in), so the
# deliberately-loose focal-unknown heuristics above are REPLACED by
# tight absolute cuts. near_fraction and the dynamic spread tests are
# scale-invariant (measured against the job's own pooled disparity
# range) and stay identical across units.
PROFILE_CLOSE_MEDIAN_M = 3.0   # meters: median subject within 3 m → close-up
PROFILE_WIDE_MEDIAN_M = 11.0   # meters: median beyond 11 m → wide
# v3 FOV classification modifier (shot-mean horizontal FOV, Depth Pro
# only — its per-frame focal estimate gives fov = 2·atan(W/(2·f_px))).
# Lens character biases shots the absolute cuts call "standard":
PROFILE_FOV_LONG_LENS_DEG = 30.0      # below = long lens
PROFILE_FOV_LONG_LENS_MEDIAN_M = 5.0  # long lens AND median < 5 m → close_up
                                      # (portrait compression reads as close
                                      # even past the 3 m cut)
PROFILE_FOV_WIDE_LENS_DEG = 60.0      # above = wide-angle lens
PROFILE_FOV_WIDE_LENS_MEDIAN_M = 8.0  # wide lens AND median > 8 m → wide
PROFILE_NEAR_FRACTION_CLOSE = 0.35
PROFILE_NEAR_FRACTION_WIDE = 0.10
# "nearest 25% of the job's disparity range" = normalized disparity > 0.75
PROFILE_NEAR_BAND = 0.75
# v6 per-shot far plane: the FAR-content depth of a shot is the 5th
# percentile of its normalized disparity (low nd = far). A robust low
# tail (not the min) so a handful of stray far pixels don't anchor the
# depth box to noise. Feeds _far_plane via the profiler stats.
PROFILE_FAR_PERCENTILE = 0.05
# "strong disagreement" between the 3 keyframes: spread of the per-frame
# median normalized disparity (the scene's depth center moved by >30% of
# the job's whole disparity range) or of the per-frame near_fraction
# (>25 pp of the image entered/left the near band) — both indicate the
# shot has large subject/camera motion and one static profile would lie.
PROFILE_DYNAMIC_DISP_SPREAD = 0.30
PROFILE_DYNAMIC_NEAR_SPREAD = 0.25
# Depth continuity: adjacent shots may differ by at most this much
# displacement, so the eye never gets yanked across a cut.
PROFILE_MAX_DISPLACEMENT_STEP = 0.00625  # v7: +25% with SHOT_PARAMS
# Pixels kept per keyframe for the profiling statistics (medians and
# fractions converge long before this; keeps memory flat per scene).
PROFILE_PIXEL_SAMPLES = 200_000

# Adaptive keyframe sampling: sample one keyframe roughly every
# PROFILE_KEYFRAME_INTERVAL_S seconds within a shot, so longer shots get
# proportionally more samples and the per-keyframe ramp can follow a
# non-linear camera move (push-in → hold → pull-out) instead of a coarse
# 3-point linear blend. Clamped to [MIN, MAX]: MIN=3 keeps short shots
# byte-identical to the old first/middle/last sampling; MAX caps the cost
# (and ramp density) on a very long single take. At ~0.3 s/keyframe of
# Depth Pro profiling, MAX=12 is ~4 s of profiling for the longest shot.
PROFILE_KEYFRAME_INTERVAL_S = 2.0
PROFILE_MIN_KEYFRAMES = 3
PROFILE_MAX_KEYFRAMES = 12


def _sample_keyframes(first: int, last: int, fps: float) -> list[int]:
    """Pick keyframe indices within a shot [first, last) at ~one every
    PROFILE_KEYFRAME_INTERVAL_S seconds, clamped to
    [PROFILE_MIN_KEYFRAMES, PROFILE_MAX_KEYFRAMES] and evenly spaced
    across the shot (endpoints always included). Returns sorted unique
    indices in [first, last). For a short shot this reduces to
    {first, middle, last-1} — identical to the prior behavior."""
    span = last - first
    if span <= 1:
        return [first]
    duration_s = span / max(fps, 1e-6)
    n = round(duration_s / PROFILE_KEYFRAME_INTERVAL_S) + 1
    n = max(PROFILE_MIN_KEYFRAMES, min(PROFILE_MAX_KEYFRAMES, n))
    n = min(n, span)  # can't sample more frames than the shot has
    if n <= 1:
        return [first]
    # evenly spaced incl. endpoints; last sample is the final frame (last-1)
    idxs = {first + round(i * (span - 1) / (n - 1)) for i in range(n)}
    return sorted(idxs)

# ---------------------------------- pro treatment v2 (stereographer)
# Depth-matched cuts: max allowed jump of the SALIENT screen disparity
# (the median-depth content the viewer is looking at) across a cut, as
# a fraction of frame width. 0.2% of width is small enough that the
# eyes re-converge without a noticeable vergence jerk.
CUT_DISPARITY_TOLERANCE = 0.002
# Comfort budget: background divergence (behind-screen disparity of the
# farthest content) ≤ 2% of width — roughly the broadcast divergence
# limit; pop-out (in-front-of-screen disparity) ≤ 0.8% of width.
MAX_BACKGROUND_DISPARITY = 0.025  # v7 (2026-09-05): +25% with SHOT_PARAMS
MAX_POPOUT_DISPARITY = 0.008
# Bounds for cut-matching placement shifts: the far plane may never be
# pushed below −1.3 × max_disp nor the near plane above +0.6 × max_disp
# (beyond these the comfort budget could not be honored by any sane
# displacement, and the depth budget geometry degenerates).
PLACEMENT_SHIFT_MIN = -1.3
PLACEMENT_SHIFT_MAX = 0.6

# Default depth-budget placement (see DepthSplatter.forward): depth 0
# (far) maps to -1.0 × max_disp (behind the screen plane) and depth 1
# (near) to +0.5 × max_disp (moderate pop-out). Chosen so default calls
# reproduce the original hard-coded ``depthmap * 1.5 - 1.0`` exactly.
# Canonically DEFINED here (not in app/stages/splat.py, which re-exports
# it) so the CPU coordinator can reference the real constant — splat.py
# imports the Forward_Warp CUDA extension at module level, so it only
# imports inside GPU containers.
DEFAULT_PLACEMENT: tuple[float, float] = (-1.0, 0.5)

# Per-shot stereo parameters. ``displacement`` is the max disparity as a
# fraction of width (VideoStereoWorker convention); ``placement`` is the
# DepthSplatter depth-budget mapping (see app/stages/splat.py).
#
# Tuning (2026-06-14, device-confirmed on dance + webm2): the original
# table RAMPED UP displacement with shot width (wide 0.018 > close 0.008),
# on the theory that distant content needs more disparity to read as deep.
# For FORWARD-WARP stereo that's backwards and was the cause of the
# "too strong + artifacts on wide shots" feedback:
#   - wider shot ⇒ more disocclusion ⇒ more inpainting ⇒ more artifacts;
#   - wider shot has more depth RANGE, so the same displacement yields a
#     bigger near↔far disparity ⇒ reads as "too strong".
# Close-ups were confirmed on point, so we KEEP 0.008 as the ceiling and
# RAMP DOWN as shots widen (A). Wide shots also go fully behind the screen
# plane (placement near-plane −0.2, a window) since pop-out is exactly
# what exposes disocclusion edges most (B).
# - close_up: confirmed on point; small displacement, mild pop-out.
# - standard (mid): "a little too strong" → modest cut from 0.0125.
# - wide: "too strong + artifacts" → LESS than standard + window (behind
#   screen), to minimize holes and divergence on full-scene shots.
# - dynamic: middle ground; its per-keyframe ramp now samples this
#   corrected table so close→far moves no longer over-deepen at the far end.
SHOT_PARAMS: dict[str, dict] = {
    # v3 (2026-06-14): gentle ~25% bump up from v2 — v2 read slightly
    # flat, so a touch more depth, still well short of the too-strong
    # original. close_up kept (on point); wide stays behind-screen.
    # v7 (2026-09-05): another uniform +25% across every class — the web
    # default still read as toned down on device. Placement (plane
    # positions) unchanged; only the disparity budget grows. Comfort
    # budget lifted in step (0.02 → 0.025) so auto-comfort does not
    # quietly claw this back on busier clips.
    # v7.1 (2026-09-05): near planes for the NON-meters bucket path (the
    # da3-metric production default) raised to mirror the meters ramp —
    # the v5/v6.1 close-up pop-out restore only ever reached the
    # depth-pro path, so web close-ups sat at +0.1 all along. close_up
    # +0.4 (= the 3 m NEAR_PLANE_RAMP anchor), dynamic +0.25 (spans close
    # and mid). Pop-out is foreground parallax: no disocclusion cost, and
    # 0.010 × 0.4 = 0.004 stays half the MAX_POPOUT_DISPARITY cap.
    # standard/wide unchanged (wides stay windowed).
    "close_up": {"displacement": 0.010, "placement": (-1.0, 0.4)},
    "standard": {"displacement": 0.0125, "placement": (-1.0, 0.3)},
    "dynamic":  {"displacement": 0.01125, "placement": (-1.0, 0.25)},
    "wide":     {"displacement": 0.010625, "placement": (-1.0, -0.2)},
}

# v4 (2026-06-14, device-confirmed): displacement is now a CONTINUOUS
# function of median depth (meters), replacing the discrete per-class
# values above. The class still sets PLACEMENT (where the plane sits),
# but DISPLACEMENT always follows depth: near ⇒ more, far ⇒ less.
# Rationale (user, dance first-shot screenshot): a far shot (figures
# filling ≤50% height against a flat wall) at the old flat wide=0.0085
# opens huge disocclusion holes the inpainter can't fill (smeared faces).
# Far content reads as far with little parallax AND can't be inpainted, so
# it needs LESS displacement. This also makes dynamic-shot keyframes taper
# correctly (a close→far push reduces disparity at the far end), since the
# ramp is applied PER-KEYFRAME on each keyframe's own median depth.
#
# Anchors (median_m → displacement), piecewise-linear, clamped at the ends:
#   2 m → 0.010 (near), 5 m → 0.008 (mid), 11 m → 0.006 (wide),
#   20 m → 0.0045 (far floor). The user's 14.9 m screenshot → 0.00535,
#   a real ~24% cut from the old 0.007/0.0085.
# v6.1 (2026-06-16): MODERATE bump on the mid/far end for more depth on
# wide/far shots (user: "increase by a moderate amount"). Near (2 m)
# unchanged — close-ups get their 3D from the restored near-plane pop-out
# above, not from displacement. Mid/wide/far lifted ~10/13/16%:
#   5 m → 0.0088, 11 m → 0.0068, 20 m → 0.0052. Kept MODERATE because this
# is the disocclusion-hole lever (the v4 cut was to stop smeared far walls);
# ProPainter fills this amount cleanly, but pushing it harder reopens that.
# v7 (2026-09-05): +25% at every anchor, in step with SHOT_PARAMS:
#   2 m → 0.0125, 5 m → 0.011, 11 m → 0.0085, 20 m → 0.0065.
DISPLACEMENT_RAMP_ANCHORS = [(2.0, 0.0125), (5.0, 0.011), (11.0, 0.0085), (20.0, 0.0065)]


def _ramp_displacement(median_depth: float, units: str = "meters") -> float:
    """Continuous displacement as a piecewise-linear function of median
    depth in METERS (depth-pro profiler). Clamped flat outside the anchor
    range. For non-meters units (da3-metric, no true scale) the ramp can't
    be applied — callers fall back to the SHOT_PARAMS bucket value."""
    m = max(DISPLACEMENT_RAMP_ANCHORS[0][0],
            min(DISPLACEMENT_RAMP_ANCHORS[-1][0], float(median_depth)))
    for (m0, d0), (m1, d1) in zip(DISPLACEMENT_RAMP_ANCHORS, DISPLACEMENT_RAMP_ANCHORS[1:]):
        if m0 <= m <= m1:
            t = (m - m0) / (m1 - m0)
            return round(d0 + t * (d1 - d0), 6)
    return DISPLACEMENT_RAMP_ANCHORS[-1][1]


# v5 (2026-06-14): the NEAR PLANE (pop-out) is now ALSO a continuous
# function of median depth, replacing the static per-class placement near
# value. ``placement`` is (far_plane, near_plane): far_plane stays −1.0
# (deepest content behind screen, no divergence issues); near_plane sets
# how far the CLOSEST content comes toward the viewer (positive = pop-out
# in front of screen, negative = still behind = a window).
# Rationale (user): with v4's disparity now right, some scenes "look 3D but
# the plane is too far back" — specifically close SUBJECTS that should pop
# but got parked behind the screen because their per-class placement didn't
# read their actual distance. Making near_plane follow depth (like
# displacement) pops near content forward regardless of class, while far
# establishing shots stay windowed (which also keeps hiding disocclusion
# edges on the shots that can't be inpainted). Applied per-shot AND
# per-keyframe, so a dynamic close→far move tapers pop-out as the subject
# recedes. The MAX_POPOUT_DISPARITY comfort cap remains the guardrail.
#
# Anchors (median_m → near_plane), piecewise-linear, clamped.
# v6 (2026-06-14, Option B): pulled the near ramp back from v5 so close
# subjects pop less aggressively (v5 read too forward on close-ups, and
# the v4 mid/far plane felt dull). The mid/far ROUNDNESS now comes from
# the per-shot far plane below, not from pushing the near plane:
#   3 m → +0.2 (was +0.4), 7 m → +0.05 (was +0.1),
#   15 m → −0.12 (mild window), 20 m → −0.2 (deep wides fully back).
# v6.1 (2026-06-16): RESTORE close-up pop-out to v5 levels. Measured
# (optical-flow disparity, v4 vs v6): close-ups read ~5-7% shallower than v4
# and visibly didn't pop (user's main complaint). The v6 "Option B" near
# pullback over-corrected. Per user: get as close to v5 as possible on
# close-ups — so the CLOSE anchors are restored to v5 EXACTLY (3 m → +0.40,
# 7 m → +0.10). 15 m / 20 m UNCHANGED — far wides stay windowed. Pop-out is
# FOREGROUND parallax, so it opens NO disocclusion holes (zero inpaint/smear
# cost), and even +0.40 stays under MAX_POPOUT_DISPARITY=0.008 (anchor, not
# cap, is the limiter — ~2x headroom). v6's per-shot far plane (below) is
# KEPT, so wides stay rounder than v5 had them.
NEAR_PLANE_RAMP_ANCHORS = [(3.0, 0.40), (7.0, 0.10), (15.0, -0.12), (20.0, -0.2)]


def _ramp_near_plane(median_depth: float) -> float:
    """Continuous near-plane (pop-out) as a piecewise-linear function of
    median depth in METERS. Clamped flat outside the anchor range. Near
    content pops forward (positive), far content recedes (negative)."""
    m = max(NEAR_PLANE_RAMP_ANCHORS[0][0],
            min(NEAR_PLANE_RAMP_ANCHORS[-1][0], float(median_depth)))
    for (m0, p0), (m1, p1) in zip(NEAR_PLANE_RAMP_ANCHORS, NEAR_PLANE_RAMP_ANCHORS[1:]):
        if m0 <= m <= m1:
            t = (m - m0) / (m1 - m0)
            return round(p0 + t * (p1 - p0), 4)
    return NEAR_PLANE_RAMP_ANCHORS[-1][1]


def _ramp_placement(median_depth: float, units: str = "meters") -> tuple:
    """v5 placement: far_plane fixed at −1.0, near_plane from the depth
    ramp. Meters-profiler only; callers fall back to the per-class
    SHOT_PARAMS placement for non-meters units.

    v6 supersedes the fixed −1.0 far plane with a PER-SHOT far plane
    (_far_plane below), so this helper now only sets the near plane; the
    caller pairs it with the per-shot far. Kept returning a tuple for
    backward compatibility (the −1.0 here is overwritten by the v6 far
    when far_nd is available)."""
    return (-1.0, _ramp_near_plane(median_depth))


# v6 (2026-06-14): PER-SHOT FAR PLANE + span refill (best-practice depth
# box). v5 pinned far=−1.0 for every shot — a NORMALIZED back plane, not
# the shot's actual farthest content. On a mid/far shot whose content
# only occupies, say, normalized depth 0.4→1.0, the depth budget was
# allocated to EMPTY space behind the content, so the real planes got
# squeezed into a thin slice ⇒ "dull/flat" mid-far shots (user feedback).
#
# Fix, in two steps per shot:
#   1. far plane tracks the shot's FAR-content normalized disparity
#      (far_nd = a low percentile of per-pixel normalized disparity;
#      0 = genuinely deep, ~1 = nothing deep / flat wall). A deep shot
#      keeps far≈−1.0; a flat/shallow-rear shot pulls far IN toward 0,
#      tightening the box around the content.
#   2. displacement is RESCALED so the occupied span (displacement ×
#      (near − far)) refills to a target budget (TARGET_SPAN). This is
#      where the roundness comes from: same total disparity, now spread
#      across only the OCCUPIED depth range instead of wasted on empty
#      rear ⇒ content planes separate more. A flat-far shot has near==far
#      collapse, so it stays shallow (few disocclusion holes) — no refill
#      room, by construction.
# The divergence cap (displacement × |far| ≤ MAX_BACKGROUND_DISPARITY)
# stays the hard safety rail in _apply_comfort_budget and is only ever
# LOOSER when far is pulled in.
#
# FAR_PULL_IN: how far toward 0 the back plane may move (far ∈ [−1.0,
# −1.0+FAR_PULL_IN]). FAR_MIN_NEG floors it so a near-content shot can't
# collapse the box to nothing.
FAR_PULL_IN = 0.55
FAR_MIN_NEG = -0.45
# Option 2 ("~1.1× v4"): the refill REDISTRIBUTES depth into the occupied
# box but never makes a shot LOUDER than its v5 ramp displacement — so v6
# inpaint is ≤ v5 everywhere (the thing the user wanted held). The gain is
# the ratio of the FULL v5 box (near − (−1.0)) to this shot's TIGHTENED box
# (near − far): a flat-far shot (far pulled in, small box) keeps the SAME
# screen disparity over its occupied range with LESS displacement ⇒ fewer
# holes; a deep shot (far≈−1.0, gain≈1) is essentially unchanged from v5.
# Capped at REFILL_GAIN_CAP (slightly above 1 = the "~1.1×" of Option 2:
# the tightest boxes may concentrate up to +10% depth, no more).
REFILL_GAIN_CAP = 1.10
# v5 reference far plane the refill measures the box against.
REFILL_REF_FAR = -1.0


def _far_plane(far_nd: float) -> float:
    """Per-shot far plane from the shot's far-content normalized disparity
    ``far_nd`` (0 = genuinely deep ⇒ far≈−1.0; →1 = nothing deep / flat
    rear ⇒ far pulled IN toward 0). Clamped to [FAR_MIN_NEG, −1.0]."""
    far = -1.0 + FAR_PULL_IN * max(0.0, min(1.0, float(far_nd)))
    return round(max(min(far, FAR_MIN_NEG), -1.0), 4)


def _refill_displacement(displacement: float, near: float, far: float) -> float:
    """v6 Option 2: hold the screen disparity over the OCCUPIED depth range
    roughly constant as the far plane tightens, WITHOUT ever exceeding the
    v5 ramp ``displacement``. The salient disparity a viewer reads scales
    with displacement × (near − far); to keep that constant when far moves
    in, displacement would scale by (near − REF_FAR)/(near − far) ≥ 1 — but
    we CAP that gain at REFILL_GAIN_CAP so v6 is at most ~1.1× v5, never the
    runaway amplification an uncapped refill produces on already-wide boxes.
    Tightening a box thus mostly REDISTRIBUTES depth (the planes that have
    content separate more) rather than turning up the volume; a collapsed
    box (near≈far) is left at the ramp value (gain→1)."""
    tight = (near - far)
    full = (near - REFILL_REF_FAR)
    if tight <= 1e-6 or full <= 1e-6:
        return round(displacement, 6)
    gain = min(full / tight, REFILL_GAIN_CAP)
    gain = max(1.0, gain)  # never tone the ramp value DOWN here (cap does the rest)
    return round(displacement * gain, 6)


# ------------------------------------------ depth-script construction
#
# Everything below is pure python (no torch) so the script-building
# math is testable offline; profile_scenes converts its tensors to
# plain floats/lists before calling _build_depth_script. See
# docs/DEPTH_SCRIPT.md for the full algorithm write-up.


def _ts(frame: int, fps: float) -> str:
    """Frame index → m:ss.cc timestamp (for the human-readable sidecar)."""
    s = frame / fps if fps else 0.0
    return f"{int(s // 60)}:{s - 60 * (s // 60):05.2f}"


def depth_script_to_yaml(script: list, fps: float, meta: dict | None = None) -> str:
    """Render a depth_script (list of per-shot dicts) as readable YAML with
    a wall-clock ``time`` range per shot, so a later re-run can eyeball the
    exact per-shot classification / far / displacement decisions. Hand-rolled
    (no PyYAML dependency in the media image); the script is flat scalars +
    a ``placement`` [far, near] pair + optional ``keyframes`` list."""
    def scalar(v):
        if isinstance(v, float):
            return repr(round(v, 6))
        if isinstance(v, bool):
            return "true" if v else "false"
        if v is None:
            return "null"
        return str(v)

    lines = ["# Per-shot depth script — durable sidecar (survives jobs-Dict rotation).",
             "# 'placement' is [far_plane, near_plane]; far pulled toward 0 = box",
             "# tightened on a flat-rear (wide) shot. 'time' is informational.",
             f"fps: {scalar(round(float(fps), 4))}"]
    if meta:
        lines.append("meta:")
        for k, v in meta.items():
            lines.append(f"  {k}: {scalar(v)}")
    lines.append(f"shot_count: {len(script)}")
    lines.append("shots:")
    for sh in script:
        first, last = int(sh["first"]), int(sh["last"])
        lines.append(f"  - time: \"{_ts(first, fps)}–{_ts(last, fps)}\"")
        lines.append(f"    frames: [{first}, {last}]")
        # ordered, readable subset first; then any remaining keys
        ordered = ["shot_type", "median", "near_fraction", "fov_deg",
                   "placement", "displacement"]
        for k in ordered:
            if k in sh:
                v = sh[k]
                if isinstance(v, list):
                    lines.append(f"    {k}: [{', '.join(scalar(x) for x in v)}]")
                else:
                    lines.append(f"    {k}: {scalar(v)}")
        if "keyframes" in sh:
            lines.append(f"    keyframes:  # {len(sh['keyframes'])} (dynamic shot)")
            for kf in sh["keyframes"]:
                inner = ", ".join(
                    f"{k}: {scalar(v) if not isinstance(v, list) else '[' + ', '.join(scalar(x) for x in v) + ']'}"
                    for k, v in kf.items())
                lines.append(f"      - {{{inner}}}")
    return "\n".join(lines) + "\n"


def _classify_keyframe(
    median_depth: float,
    near_fraction: float,
    units: str = "da3_metric",
    fov_deg: float | None = None,
) -> str:
    """Classify a single keyframe (or a whole non-dynamic shot — the
    thresholds are identical). Spread checks don't apply to one frame,
    so a lone keyframe is close_up / wide / standard, never dynamic.

    ``units`` selects the absolute-threshold calibration:
    - ``"da3_metric"`` (default): focal-normalized da3-metric units —
      deliberately loose because the true focal is unknown.
    - ``"meters"`` (v3, Depth Pro): TRUE meters — the tight
      PROFILE_CLOSE_MEDIAN_M / PROFILE_WIDE_MEDIAN_M cuts replace the
      loose heuristics. The near_fraction thresholds are
      scale-invariant and shared by both calibrations.

    ``fov_deg`` (v3, meters only): shot-mean horizontal FOV used as a
    classification MODIFIER between the absolute cuts — long lens
    (< 30°) with median < 5 m biases to close_up; wide-angle lens
    (> 60°) with median > 8 m (and a clear foreground) biases to wide.
    """
    if units not in ("da3_metric", "meters"):
        raise ValueError(f"unknown units {units!r}, expected 'da3_metric' or 'meters'")
    close_cut, wide_cut = (
        (PROFILE_CLOSE_MEDIAN_M, PROFILE_WIDE_MEDIAN_M)
        if units == "meters"
        else (PROFILE_CLOSE_MEDIAN, PROFILE_WIDE_MEDIAN)
    )
    if (median_depth < close_cut
            or near_fraction > PROFILE_NEAR_FRACTION_CLOSE):
        return "close_up"
    if units == "meters" and fov_deg is not None:
        if (fov_deg < PROFILE_FOV_LONG_LENS_DEG
                and median_depth < PROFILE_FOV_LONG_LENS_MEDIAN_M):
            return "close_up"
        if (fov_deg > PROFILE_FOV_WIDE_LENS_DEG
                and median_depth > PROFILE_FOV_WIDE_LENS_MEDIAN_M
                and near_fraction < PROFILE_NEAR_FRACTION_WIDE):
            return "wide"
    if (median_depth > wide_cut
            and near_fraction < PROFILE_NEAR_FRACTION_WIDE):
        return "wide"
    return "standard"


def _salient_screen_disp(displacement: float, placement, nd: float) -> float:
    """Signed screen disparity, as a fraction of frame width, of content
    at normalized disparity ``nd`` — the same mapping DepthSplatter
    applies: displacement × (nd × (placement[1] − placement[0]) +
    placement[0])."""
    return displacement * (nd * (placement[1] - placement[0]) + placement[0])


def _boundary_params(entry: dict, edge: int) -> dict:
    """The dict carrying the stereo params active at a shot edge
    (``edge=0`` incoming/first frame, ``edge=-1`` outgoing/last frame):
    the boundary keyframe for dynamic shots (which ramp), the entry
    itself otherwise. Returned by reference so callers can adjust it."""
    keyframes = entry.get("keyframes")
    return keyframes[edge] if keyframes else entry


def _apply_comfort_budget(holder: dict, label: str, notes: list) -> None:
    """Scale ``holder['displacement']`` DOWN (never placement — moving
    placement would un-match a depth-matched cut) until background
    divergence ≤ MAX_BACKGROUND_DISPARITY and pop-out ≤
    MAX_POPOUT_DISPARITY. Appends a human-readable note when it fires."""
    disp = float(holder["displacement"])
    p0, p1 = holder["placement"]
    background = disp * abs(min(float(p0), 0.0))
    popout = disp * max(float(p1), 0.0)
    scale = 1.0
    reasons = []
    if background > MAX_BACKGROUND_DISPARITY:
        scale = min(scale, MAX_BACKGROUND_DISPARITY / background)
        reasons.append("divergence cap")
    if popout > MAX_POPOUT_DISPARITY:
        scale = min(scale, MAX_POPOUT_DISPARITY / popout)
        reasons.append("pop-out cap")
    if scale < 1.0:
        holder["displacement"] = round(disp * scale, 6)
        notes.append(
            f"{label}displacement scaled {disp}→{holder['displacement']} "
            f"({', '.join(reasons)})"
        )


def _keyframe_params(
    idx, depth, near_frac, far_nd, units, fov_mean, depth_scale,
) -> dict:
    """One dynamic-shot keyframe's stereo params, ramped on its OWN depth.
    Meters: displacement/near from the depth ramps; v6 far plane + span
    refill from this keyframe's far_nd (None ⇒ v5 fixed −1.0, no refill).
    Non-meters: per-class SHOT_PARAMS bucket (unchanged)."""
    if units == "meters":
        near_plane = _ramp_near_plane(depth)
        if far_nd is not None:
            far_plane = _far_plane(far_nd)
            disp = _refill_displacement(
                _ramp_displacement(depth), near_plane, far_plane)
        else:
            far_plane = -1.0
            disp = _ramp_displacement(depth)
        placement = (far_plane, near_plane)
    else:
        cls = _classify_keyframe(depth, near_frac, units=units, fov_deg=fov_mean)
        disp = SHOT_PARAMS[cls]["displacement"]
        placement = SHOT_PARAMS[cls]["placement"]
    return {
        "index": int(idx),
        "displacement": round(disp * depth_scale, 6),
        "placement": list(placement),
    }


def _build_depth_script(
    per_scene_stats: list, lo: float, hi: float, units: str = "da3_metric",
    depth_scale: float = 1.0,
) -> list:
    """Build the per-shot depth script from plain-python keyframe stats
    (pro treatment v2 + FOV-informed v3). Pure function, no torch —
    testable offline.

    ``per_scene_stats``: one dict per shot, in shot order:
      {"first": int, "last": int,
       "keyframes": [abs frame index, ...],           # sorted, adaptive N (≥3)
       "median_depth": [median raw depth per kf],     # ``units`` scale
       "median_disp": [median raw disparity per kf],  # 1/depth
       "near_fraction": [near-band pixel fraction per kf],
       optional "fov_deg": [horizontal FOV per kf, ...],  # v3, may hold None
       optional "units": str}                         # bookkeeping flag
    ``lo``/``hi``: job-wide disparity range (pooled keyframe p1/p99) —
    per-keyframe median normalized disparity is recovered as
    clip((median_disp − lo) / (hi − lo), 0, 1).
    ``units``: depth-unit calibration for the absolute classification
    thresholds — "da3_metric" (default, byte-identical v2 behavior) or
    "meters" (v3, Depth Pro): see _classify_keyframe. Per-job, not
    per-scene (one profiler model serves the whole job).

    v3: when a shot's stats carry "fov_deg", the shot-mean FOV is used
    as a classification modifier (see _classify_keyframe) — including
    for the per-keyframe ramps of dynamic shots (lens character is a
    per-shot property) — and recorded on the entry as "fov_deg"
    (1 dp). Everything downstream of classification (clamp, cuts,
    comfort) operates on normalized disparity and is unit-agnostic.

    Stages, in order:
      1. classify each shot (dynamic → close_up → wide → standard) and
         assign SHOT_PARAMS. Dynamic shots also classify EACH keyframe
         alone and emit a "keyframes" ramp (consumers interpolate); the
         top-level params stay the dynamic compromise for consumers
         that ignore keyframes.
      2. v1 continuity: clamp adjacent-shot displacement deltas to
         ≤ PROFILE_MAX_DISPLACEMENT_STEP (forward pass).
      3. v2 depth-matched cuts: forward pass over cuts — shift the
         incoming shot's placement uniformly so the salient screen
         disparity jump is ≤ CUT_DISPARITY_TOLERANCE, with the shift
         bounded by PLACEMENT_SHIFT_MIN/MAX. For dynamic shots the
         boundary KEYFRAME is matched (first incoming / last outgoing).
      4. v2 comfort budget, applied last: scale displacement down per
         shot AND per keyframe to honor the divergence/pop-out caps.
         (Scaling after matching changes screen_disp linearly — a
         documented v2 approximation.)

    Each entry keeps the v1 keys and gains "screen_disp_in" /
    "screen_disp_out" (post-adjustment, 5 dp) plus "adjustments"
    (list of strings) when any correction fired.

    ``depth_scale``: uniform per-job multiplier on every shot's (and
    keyframe's) displacement, applied at SHOT_PARAMS lookup so all
    downstream stages see scaled values: cut-matching is preserved
    proportionally (screen disparities and jumps scale together) and
    the comfort caps stay HARD limits. The v1 step clamp scales too,
    keeping the relative shot-to-shot structure identical. Use < 1.0
    to tone the whole effect down when subjects sit at mid distance
    (per-scene depth normalization otherwise stretches them across
    the full budget).
    """
    scale = max(hi - lo, 1e-6)
    max_step = PROFILE_MAX_DISPLACEMENT_STEP * depth_scale
    script: list = []
    med_nds: list = []  # per shot: per-keyframe median normalized disparity
    notes: list = []    # per shot: adjustment strings

    # stage 1 — classification + SHOT_PARAMS (and keyframe ramps)
    for s in per_scene_stats:
        depth_med = [float(v) for v in s["median_depth"]]
        near = [float(v) for v in s["near_fraction"]]
        med_nd = [
            min(max((float(d) - lo) / scale, 0.0), 1.0) for d in s["median_disp"]
        ]
        # v6: per-keyframe far-content normalized disparity (0 = deep,
        # →1 = flat rear). Profiler emits it ("far_nd"); absent on resumed
        # pre-v6 sidecars, in which case the far plane falls back to −1.0
        # (v5 behavior) and no span refill happens.
        far_nd_kf = [float(v) for v in (s.get("far_nd") or [])]
        # v3: shot-mean FOV (Nones dropped — a resumed scene's sidecar
        # may predate the feature); None when the profiler has no FOV
        fovs = [float(v) for v in (s.get("fov_deg") or []) if v is not None]
        fov_mean = sum(fovs) / len(fovs) if fovs else None
        # lower-middle median, matching torch.median over the keyframes
        median_depth = sorted(depth_med)[(len(depth_med) - 1) // 2]
        near_fraction = sum(near) / len(near)
        disp_spread = max(med_nd) - min(med_nd)
        near_spread = max(near) - min(near)

        if (disp_spread > PROFILE_DYNAMIC_DISP_SPREAD
                or near_spread > PROFILE_DYNAMIC_NEAR_SPREAD):
            shot_type = "dynamic"
        else:
            shot_type = _classify_keyframe(
                median_depth, near_fraction, units=units, fov_deg=fov_mean
            )

        params = SHOT_PARAMS[shot_type]
        # v4: displacement is the depth ramp (meters profiler).
        # v5: placement (near plane / pop-out) is ALSO the depth ramp.
        # v6: far plane is PER-SHOT (from far_nd) and displacement is
        # REFILLED so the occupied span hits TARGET_SPAN (see _far_plane /
        # _refill_displacement). All meters-only; non-meters units fall
        # back to the per-class SHOT_PARAMS bucket (no true depth scale).
        if units == "meters":
            near_plane = _ramp_near_plane(median_depth)
            if far_nd_kf:
                far_plane = _far_plane(sum(far_nd_kf) / len(far_nd_kf))
                shot_disp = _refill_displacement(
                    _ramp_displacement(median_depth), near_plane, far_plane)
            else:  # pre-v6 sidecar: keep v5 fixed far, no refill
                far_plane = -1.0
                shot_disp = _ramp_displacement(median_depth)
            shot_placement = (far_plane, near_plane)
        else:
            shot_disp = params["displacement"]
            shot_placement = params["placement"]
        entry = {
            "first": int(s["first"]),
            "last": int(s["last"]),
            "shot_type": shot_type,
            "displacement": round(shot_disp * depth_scale, 6),
            "placement": list(shot_placement),
            "median": round(median_depth, 4),
            "near_fraction": round(near_fraction, 4),
        }
        if fov_mean is not None:
            entry["fov_deg"] = round(fov_mean, 1)
        if shot_type == "dynamic":
            # per-keyframe: BOTH displacement and placement ramp on EACH
            # keyframe's own depth (a close→far push tapers disparity AND
            # recedes the pop-out; a far→close push brings the subject
            # forward as it approaches). v6: the far plane + span refill
            # are also per-keyframe (each keyframe's own far_nd), so a
            # dynamic move retightens the box frame-by-frame.
            kf_far_nd = far_nd_kf or [None] * len(s["keyframes"])
            entry["keyframes"] = [
                _keyframe_params(idx, d, nf, fnd, units, fov_mean, depth_scale)
                for idx, d, nf, fnd in zip(
                    s["keyframes"], depth_med, near, kf_far_nd)
            ]
        script.append(entry)
        med_nds.append(med_nd)
        notes.append([])

    # stage 2 — v1 displacement continuity (forward pass; earlier shots
    # anchor later ones, so a lone outlier is pulled toward its context)
    for i in range(1, len(script)):
        prev = script[i - 1]["displacement"]
        want = script[i]["displacement"]
        clamped = min(max(want, prev - max_step), prev + max_step)
        if clamped != want:
            script[i]["displacement"] = round(clamped, 6)
            notes[i].append(
                f"displacement clamped {want}→{script[i]['displacement']} "
                "(adjacent-shot step)"
            )

    # stage 3 — v2 depth-matched cuts (forward pass: the adjusted state
    # of shot i is what shot i+1 matches against)
    for i in range(1, len(script)):
        b_out = _boundary_params(script[i - 1], -1)
        b_in = _boundary_params(script[i], 0)
        sd_out = _salient_screen_disp(
            b_out["displacement"], b_out["placement"], med_nds[i - 1][-1])
        sd_in = _salient_screen_disp(
            b_in["displacement"], b_in["placement"], med_nds[i][0])
        jump = sd_in - sd_out
        if abs(jump) <= CUT_DISPARITY_TOLERANCE or b_in["displacement"] <= 0:
            continue
        sign = 1.0 if jump > 0 else -1.0
        delta = -(jump - sign * CUT_DISPARITY_TOLERANCE) / b_in["displacement"]
        p0, p1 = (float(v) for v in b_in["placement"])
        applied = min(max(delta, PLACEMENT_SHIFT_MIN - p0), PLACEMENT_SHIFT_MAX - p1)
        b_in["placement"] = [round(p0 + applied, 6), round(p1 + applied, 6)]
        note = (
            f"placement shifted {applied:+.4f} to match cut at frame "
            f"{script[i]['first']}"
        )
        if abs(applied - delta) > 1e-9:
            note += " (shift clamped; residual jump above tolerance)"
        notes[i].append(note)

    # stage 4 — v2 comfort budget, per shot and per keyframe, last
    for i, entry in enumerate(script):
        _apply_comfort_budget(entry, "", notes[i])
        for kf in entry.get("keyframes", []):
            _apply_comfort_budget(kf, f"keyframe {kf['index']}: ", notes[i])

    # bookkeeping — post-adjustment boundary disparities + adjustments
    for i, entry in enumerate(script):
        b_in = _boundary_params(entry, 0)
        b_out = _boundary_params(entry, -1)
        entry["screen_disp_in"] = round(_salient_screen_disp(
            b_in["displacement"], b_in["placement"], med_nds[i][0]), 5)
        entry["screen_disp_out"] = round(_salient_screen_disp(
            b_out["displacement"], b_out["placement"], med_nds[i][-1]), 5)
        if notes[i]:
            entry["adjustments"] = notes[i]
    return script


def _percentile(sorted_values: list, q: float) -> float:
    """Linear-interpolation percentile (numpy default) of an already
    SORTED, non-empty list. ``q`` in [0, 1]. Kept torch-free so the
    auto-comfort math stays offline-testable."""
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    pos = q * (len(sorted_values) - 1)
    lo_i = int(pos)
    hi_i = min(lo_i + 1, len(sorted_values) - 1)
    frac = pos - lo_i
    return float(sorted_values[lo_i]) * (1.0 - frac) + float(sorted_values[hi_i]) * frac


def _auto_comfort_scale(script: list, comfort_budget: float) -> float:
    """Scale that brings the clip's peak salient screen disparity within
    ``comfort_budget``. Measures the p95 of |screen_disp_in| /
    |screen_disp_out| across all shots and returns
    ``clamp(comfort_budget / measured, 0.3, 1.0)`` — it only ever tones
    DOWN (>1.0 capped at 1.0 so a quiet clip is never pushed past the
    artistic default). ``measured == 0`` (degenerate / empty) → 1.0.

    Uses p95 of the absolute shot-boundary screen disparities so a
    single outlier shot does not crush the whole video; with few shots
    p95 ≈ max, which is fine.
    """
    disps: list = []
    for entry in script:
        for key in ("screen_disp_in", "screen_disp_out"):
            if key in entry:
                disps.append(abs(float(entry[key])))
    if not disps:
        return 1.0
    measured = _percentile(sorted(disps), 0.95)
    if measured <= 0.0:
        return 1.0
    return min(max(comfort_budget / measured, 0.3), 1.0)


def _apply_auto_comfort(
    per_scene_stats: list, lo: float, hi: float, units: str = "da3_metric",
    auto_comfort: bool = False, comfort_budget: float = MAX_BACKGROUND_DISPARITY,
    depth_scale: float = 1.0,
) -> tuple[list, float]:
    """Build the depth script, applying auto-comfort when requested.
    Returns ``(script, applied_scale)``.

    Precedence (matches the design):
    - An explicit ``depth_scale != 1.0`` is a MANUAL override and always
      wins — auto-comfort is skipped and ``applied_scale == depth_scale``.
    - ``auto_comfort`` with the default ``depth_scale == 1.0``: build once
      at scale 1.0, measure p95 boundary disparity vs ``comfort_budget``
      via ``_auto_comfort_scale``, and if the computed scale < 1.0 REBUILD
      the script at that scale (so cut-matching / comfort / step-clamp all
      recompute proportionally — a post-multiply would leave depth-matched
      placement shifts wrong). ``applied_scale`` is the chosen scale.
    - ``auto_comfort`` False: build at ``depth_scale`` (1.0 default),
      ``applied_scale == depth_scale``.

    Pure (no torch) so the whole measure/rebuild loop is offline-testable.
    """
    script = _build_depth_script(
        per_scene_stats, lo, hi, units=units, depth_scale=depth_scale
    )
    # manual depth_scale override, or auto-comfort off → nothing to do
    if not auto_comfort or depth_scale != 1.0:
        return script, depth_scale
    chosen = _auto_comfort_scale(script, comfort_budget)
    if chosen < 1.0:
        script = _build_depth_script(
            per_scene_stats, lo, hi, units=units, depth_scale=chosen
        )
    return script, chosen


with depth_models_image.imports():
    import ffmpeg
    import torch
    import torchvision.transforms.v2 as v2
    from torchcodec.decoders import VideoDecoder

    from app.common.weights import ensure_da2, ensure_da2_metric, ensure_da3, ensure_depth_pro


def _gray16_video_writer(h: int, w: int, fps, file: str | Path):
    """ffmpeg writer consuming raw gray16le frames on stdin.

    Duplicated from app/stages/depth_processor.py: importing that
    module would pull the vendored VideoDepthAnything stack (and its
    image deps) into this container for the sake of ten lines.
    """
    return (
        ffmpeg.input("pipe:", format="rawvideo", pix_fmt="gray16le", s=f"{w}x{h}", r=fps)
        .output(
            str(file),
            pix_fmt="gray16le",
            vcodec="libx264",
            preset="slow",
            crf=18,
            vsync="cfr",
            r=fps,
        )
        .global_args("-loglevel", "error", "-threads", "0")
        .overwrite_output()
        .run_async(pipe_stdin=True)
    )


def _detect_scene_ranges(path: Path, num_frames: int) -> list[tuple[int, int]]:
    """Scene boundaries [(first, last), ...] covering all frames.

    Runs up front (blocking) rather than concurrently with inference as
    DepthProcessor does: metric models need a sampling pre-pass before
    any depth is written anyway, and relative models need a scene's
    full extent before its normalization. Only internal cut positions
    are taken from scenedetect — the total comes from the decoder, so
    the ranges always sum to exactly ``num_frames``.
    """
    from scenedetect import AdaptiveDetector, SceneManager, open_video

    video = open_video(str(path))
    manager = SceneManager()
    manager.add_detector(AdaptiveDetector())
    manager.detect_scenes(video=video)
    cuts = sorted(
        {s.get_frames() for s, _ in manager.get_scene_list()[1:] if 0 < s.get_frames() < num_frames}
    )
    bounds = [0, *cuts, num_frames]
    return list(zip(bounds[:-1], bounds[1:]))


def _resize_shape(source_shape: tuple[int, int], input_size: int) -> tuple[int, int]:
    """Working resolution: short side = input_size, both multiples of
    14 (same rule as DepthProcessor)."""
    height, width = source_shape
    ratio = max(height, width) / min(height, width)
    if height > width:
        return (round(input_size * ratio / 14) * 14, input_size)
    return (input_size, round(input_size * ratio / 14) * 14)


# ------------------------------------------ shared model load + inference
#
# FrameDepthWorker (main per-frame depth, 4h timeout) and ShotProfiler
# (adaptive 3-keyframe profiler, 10-min timeout) run the SAME depth
# backends — DA2-metric / DA3 / DA3-metric / Depth Pro — so the
# model-construction and the per-backend inference adapters live here as
# module-level functions that BOTH classes' @modal.enter load() and
# inference helpers delegate to. There is ONE implementation of each;
# the only per-class difference is the @app.cls config (timeout +
# retries) and which @modal.method entrypoints are exposed. Keeping these
# as module functions (rather than a mixin) sidesteps the Modal @app.cls
# constraint that @modal.enter/@modal.method live on the decorated class,
# while still giving a single source of truth for the depth math.


def _build_model(model_name: str):
    """Construct and return the depth model for ``model_name`` on cuda
    (eval mode). Shared by both worker classes' @modal.enter load()."""
    if model_name == "da2":
        from transformers import DepthAnythingForDepthEstimation

        # relative DA2-Large — the mobile app's on-device model; output is
        # relative disparity (see DISPARITY_MODELS)
        return (
            DepthAnythingForDepthEstimation.from_pretrained(str(ensure_da2()))
            .to("cuda")
            .eval()
        )
    if model_name.startswith("da2-metric"):
        from transformers import DepthAnythingForDepthEstimation

        variant = model_name.rsplit("-", 1)[-1]  # indoor | outdoor
        return (
            DepthAnythingForDepthEstimation.from_pretrained(str(ensure_da2_metric(variant)))
            .to("cuda")
            .eval()
        )
    if model_name == "depth-pro":
        import dataclasses

        from depth_pro.depth_pro import DEFAULT_MONODEPTH_CONFIG_DICT, create_model_and_transforms

        config = dataclasses.replace(
            DEFAULT_MONODEPTH_CONFIG_DICT, checkpoint_uri=str(ensure_depth_pro())
        )
        # fp16 per the official CLI; the returned transform is discarded
        # — it targets PIL/ndarray input, while these workers normalize
        # decoded uint8 tensors themselves (see _make_infer)
        model, _ = create_model_and_transforms(
            config=config, device=torch.device("cuda"), precision=torch.half
        )
        return model.eval()
    from depth_anything_3.api import DepthAnything3

    checkpoint = ensure_da3("mono-large", metric=model_name == "da3-metric")
    return DepthAnything3.from_pretrained(str(checkpoint)).to("cuda")


def _make_infer(model, model_name: str, source_shape: tuple[int, int], input_size: int,
                fov_samples: list):
    """Bind a ``(T, C, H, W) uint8 cpu -> (T, h, w) float32 cpu raw
    depth`` function for this call's video geometry. ``fov_samples`` is
    the list the depth-pro path appends one horizontal-FOV value per
    frame to (callers reset it per scene). Shared by both classes."""
    if model_name == "da2" or model_name.startswith("da2-metric"):
        resize_shape = _resize_shape(source_shape, input_size)
        # Official DA2 preprocessing: aspect-preserving resize to
        # multiples of 14 + ImageNet stats, no padding (≤7 px of
        # aspect distortion from the rounding).
        pre = torch.nn.Sequential(
            v2.ToDtype(torch.float32, scale=True),
            v2.Resize(size=resize_shape, interpolation=v2.InterpolationMode.BICUBIC, antialias=True),
            v2.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        )
        return lambda frames: _infer_da2(model, frames, pre)
    if model_name == "depth-pro":
        resize_shape = _resize_shape(source_shape, input_size)
        # [-1, 1] normalization per the official transform
        # (Normalize([0.5]*3, [0.5]*3)); resize to the working
        # resolution first so the returned depth honors the same
        # depth_shape contract as the other backends
        pre = torch.nn.Sequential(
            v2.ToDtype(torch.float32, scale=True),
            v2.Resize(size=resize_shape, interpolation=v2.InterpolationMode.BICUBIC, antialias=True),
            v2.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5]),
        )
        return lambda frames: _infer_depth_pro(model, frames, pre, fov_samples)
    return lambda frames: _infer_da3(model, frames, input_size)


def _infer_da2(model, frames: "torch.Tensor", pre) -> "torch.Tensor":
    """transformers DA2-metric: returns depth in meters at the
    working resolution."""
    with torch.no_grad(), torch.autocast(device_type="cuda"):
        depth = model(pixel_values=pre(frames.cuda())).predicted_depth  # (T, h, w)
    return depth.float().cpu()


def _infer_da3(model, frames: "torch.Tensor", input_size: int) -> "torch.Tensor":
    """DA3 api: its InputProcessor handles resize (short side =
    input_size via lower_bound_resize, matching the VDA working-
    resolution convention) + ImageNet normalization. With
    ``alt_start=-1`` in the mono/metric presets there is no
    cross-view attention, so batching frames cannot couple them."""
    imgs = [f.permute(1, 2, 0).contiguous().numpy() for f in frames]  # HWC RGB uint8
    prediction = model.inference(
        imgs, process_res=input_size, process_res_method="lower_bound_resize"
    )
    return torch.from_numpy(prediction.depth).float()  # (T, h, w)


def _infer_depth_pro(model, frames: "torch.Tensor", pre, fov_samples: list) -> "torch.Tensor":
    """Apple Depth Pro: absolute metric depth in meters at the
    working resolution, plus a per-frame horizontal-FOV estimate.

    ``model.infer`` resamples internally to the fixed 1536x1536
    network input (squashing aspect, by upstream design) and
    returns depth resized back to the resolution it was given.
    Frames run ONE at a time: infer's f_px math assumes a single
    image — with a batch, the (B, 1) focal tensor mis-broadcasts
    against the (B, 1, H, W) canonical inverse depth.

    The horizontal FOV is recovered exactly from the estimated
    focal length, fov = 2*atan(W / (2*f_px)) — the inverse of
    infer's own ``f_px = W / (2*tan(fov/2))`` — and appended to
    ``fov_samples`` for per-scene means. FOV is invariant to
    uniform resizing, so the working-resolution resize (≤7 px of
    aspect rounding) does not bias it.
    """
    import math

    x = pre(frames.cuda()).half()
    width = x.shape[-1]
    depths = []
    for i in range(x.shape[0]):
        out = model.infer(x[i])
        depths.append(out["depth"].float().cpu())  # (h, w) meters
        f_px = float(out["focallength_px"])
        fov_samples.append(math.degrees(2.0 * math.atan(width / (2.0 * f_px))))
    return torch.stack(depths)


@app.cls(
    gpu=FRAME_DEPTH_GPU,
    image=depth_models_image,
    volumes=GPU_VOLUMES,
    secrets=[hf_secret, slack_secret],
    cpu=4,
    memory=(4 * 1024, 128 * 1024),
    # Per-frame backends (DA3 / Depth Pro) run as a SINGLE worker — they
    # need one job-wide p1/p99 disparity pass for cross-scene metric
    # consistency, so they CANNOT fan out like VDA. At ~2 fps a 10-min
    # clip is ~2h, so allow 4h. profile_scenes (3 keyframes/shot) is
    # always cheap; the risk is a full per-frame depth pass on a long
    # clip. (Production depth is VDA-only; this guards experiments.)
    timeout=4 * 3600,
    scaledown_window=SCALEDOWN_WINDOW,
    retries=modal.Retries(max_retries=2, initial_delay=10.0, backoff_coefficient=2.0),
)
class FrameDepthWorker:
    model_name: str = modal.parameter(default="da3")

    @modal.enter()
    def load(self) -> None:
        if self.model_name not in DEPTH_MODELS:
            raise ValueError(f"unknown depth model {self.model_name!r}, expected one of {DEPTH_MODELS}")
        start = time.perf_counter()
        torch.backends.cudnn.benchmark = True
        self.metric = self.model_name in METRIC_MODELS
        # per-frame horizontal-FOV samples (depth-pro only): the infer
        # closure appends one value per frame; generate() resets the
        # list per scene and turns it into per-scene means
        self._fov_samples: list[float] = []
        self.model = _build_model(self.model_name)
        logger.info(f"🚀 {self.model_name} loaded in {time.perf_counter() - start:.1f}s")

    @modal.exit()
    def flush(self) -> None:
        # also runs on preemption (30s grace): persist finished scene
        # segments so the retried call can resume instead of restarting
        cache_volume.commit()

    @modal.method()
    @fail_fast
    def generate(
        self,
        job_id: str,
        input_path: str,
        input_size: int = 980,
        batch_size: int = 8,
        fps_rational: str | None = None,
        band: tuple[float, float] = (0.0, 1.0),
    ) -> dict:
        """Compute a per-frame depth video for ``input_path`` (a path
        inside the cache volume or bucket mount). Returns metadata
        including the cache-volume path of the gray16le depth video —
        the same contract as VideoDepthWorker.generate.

        Resumable: scene segments completed before a preemption are
        skipped on the retried call."""
        if input_size % 14 != 0:
            raise ValueError(f"input_size must be a multiple of 14, got {input_size}")
        safe_reload(cache_volume)  # pick up files written by upstream stages
        src = Path(input_path)
        if not src.exists():
            raise FileNotFoundError(f"input video not found: {src}")

        out = job_cache_dir(job_id) / "depth.mp4"
        decoder = VideoDecoder(str(src), device="cpu", num_ffmpeg_threads=0)
        meta = decoder.metadata
        if meta.height is None or meta.width is None:
            raise ValueError(f"could not read dimensions of {src}")
        source_shape = (meta.height, meta.width)
        total_frames = meta.num_frames
        fps = fps_rational or float(meta.average_fps)
        infer = self._make_infer(source_shape, input_size)

        # client-facing progress, throttled to one dict write per ~5s
        start = time.perf_counter()
        last_report = [0.0]

        def on_progress(done: int, total: int) -> None:
            now = time.perf_counter()
            if now - last_report[0] < 5 and done < total:
                return
            last_report[0] = now
            jobs.report_progress(
                job_id, "video_depth", done, total,
                rate_per_s=done / max(now - start, 1e-6), band=tuple(band),
            )

        with jobs.stage_timer(
            job_id, "video_depth",
            gpu=torch.cuda.get_device_name(0).replace("NVIDIA ", ""),
            input_size=input_size, model=self.model_name,
        ):
            ranges = _detect_scene_ranges(src, total_frames)
            jlog_cuts = [first for first, _ in ranges[1:]]
            logger.info(f"🔪 {len(ranges)} scene(s), cuts at {jlog_cuts or 'none'}")

            # DISPARITY_MODELS (relative DA2) already output disparity —
            # everything else outputs depth and gets inverted
            invert = self.model_name not in DISPARITY_MODELS
            disp_range: tuple[float, float] | None = None
            if self.metric:
                disp_range = self._estimate_disparity_range(
                    decoder, total_frames, batch_size, infer, invert=invert)
                logger.info(f"📏 job-wide disparity range (p1, p99) = {disp_range}")

            seg_dir = Path(f"{out}.segments")
            seg_dir.mkdir(parents=True, exist_ok=True)
            to_u16 = v2.ToDtype(torch.uint16, scale=True)
            depth_shape: tuple[int, int] | None = None

            # depth-pro: collect the per-frame FOV estimates into one
            # mean per scene; checkpointed in a sidecar JSON next to
            # the scene segment so a resumed (skipped) scene keeps its
            # value instead of degrading to null
            collect_fov = self.model_name == "depth-pro"
            scene_fovs: list[float | None] = []

            segments: list[Path] = []
            num_frames = 0
            for first, last in ranges:
                seg = seg_dir / f"depth_{first:08d}_{last:08d}.mp4"
                fov_file = seg.with_suffix(".fov.json")
                if seg.exists() and count_frames(seg) == last - first:
                    logger.info(f"⏭  scene [{first}, {last}) already done, skipping")
                    if collect_fov:
                        scene_fovs.append(
                            json.loads(fov_file.read_text())["fov_deg"] if fov_file.exists() else None
                        )
                else:
                    self._fov_samples = []
                    disp = self._scene_disparity(
                        decoder, first, last, batch_size, infer,
                        on_batch=lambda done, base=num_frames: on_progress(base + done, total_frames),
                        align_frames=(disp_range is None),  # relative models only
                        invert=invert,
                    )
                    if collect_fov:
                        fov = (
                            sum(self._fov_samples) / len(self._fov_samples)
                            if self._fov_samples else None
                        )
                        scene_fovs.append(fov)
                        fov_file.write_text(json.dumps({"fov_deg": fov}))
                        if fov is not None:
                            logger.info(f"📐 scene [{first}, {last}) mean horizontal FOV: {fov:.1f}°")
                    normalized = self._normalize(disp, disp_range)
                    track(f"scene_depth[{first}:{last}]", normalized, logger)
                    if depth_shape is None:
                        depth_shape = (normalized.shape[-2], normalized.shape[-1])
                    writer = _gray16_video_writer(h=depth_shape[0], w=depth_shape[1], fps=fps, file=seg)
                    try:
                        writer.stdin.write(to_u16(normalized.unsqueeze(1)).numpy().tobytes())
                    finally:
                        writer.stdin.close()
                        writer.wait()
                    del disp, normalized
                segments.append(seg)
                num_frames += last - first
                cache_volume.commit()  # checkpoint: scene segment survives preemption

            if depth_shape is None:  # every segment was resumed from cache
                depth_shape = _resize_shape(source_shape, input_size)
            concat_segments(segments, out)
            written = count_frames(out)
            if written != num_frames:
                raise RuntimeError(
                    f"depth frame count mismatch: wrote {written}, expected {num_frames} "
                    "— refusing to continue (audio would drift out of sync)"
                )

        cache_volume.commit()
        del decoder  # drop decoder file handles before the next input
        torch.cuda.empty_cache()

        result = {
            "depth_path": str(out),
            "num_frames": num_frames,
            "fps": float(meta.average_fps),
            "source_shape": list(source_shape),
            "depth_shape": list(depth_shape),
            "scene_cuts": jlog_cuts,
        }
        if collect_fov:
            # additive key (depth-pro only): mean horizontal FOV in
            # degrees per scene, ordered like the scene ranges implied
            # by scene_cuts (null for a resumed scene whose sidecar
            # predates this feature)
            result["fov_deg"] = [round(f, 2) if f is not None else None for f in scene_fovs]
        return result

    # -------------------------------------------------------- inference

    def _make_infer(self, source_shape: tuple[int, int], input_size: int):
        """Delegate to the shared module-level ``_make_infer`` (same
        binding for both worker classes), threading this worker's
        ``_fov_samples`` list so the depth-pro path accumulates per-frame
        FOV estimates the same way it always has."""
        return _make_infer(
            self.model, self.model_name, source_shape, input_size, self._fov_samples
        )

    def _scene_disparity(
        self, decoder, first: int, last: int, batch_size: int, infer, on_batch,
        align_frames: bool = False, invert: bool = True,
    ) -> "torch.Tensor":
        """Raw disparity (N, h, w) float16 on CPU for one scene.
        on_batch(done_in_scene) fires per inference batch.

        invert: True when the model outputs DEPTH (disparity = 1/depth,
        the historical behavior); False for DISPARITY_MODELS (relative
        DA2), whose raw output already IS disparity — inverting it would
        flip near and far into plausible-looking inverted stereo.

        align_frames (relative models): each frame's disparity is
        affinely aligned (scale+shift least squares, VDA-style) to the
        previous aligned frame — per-frame relative outputs each have an
        arbitrary affine, and scene-wide min-max alone cannot remove
        that frame-to-frame flicker. Metric models skip this (their
        scale is already consistent).
        """
        chunks: list[torch.Tensor] = []
        ref: torch.Tensor | None = None
        for b0 in range(first, last, batch_size):
            b1 = min(b0 + batch_size, last)
            depth = infer(decoder[b0:b1])
            if invert:
                disp = depth.clamp(min=DEPTH_EPS).reciprocal().float()
            else:  # already disparity — just floor it for the affine fits
                disp = depth.clamp(min=0.0).float()
            if align_frames:
                # Anchor every frame to the scene's FIRST frame: chaining
                # frame->previous compounds scale errors multiplicatively
                # and collapses the signal to a constant over long scenes
                # (observed). A fixed anchor cannot drift; the scale guard
                # rejects degenerate fits (e.g. momentary occlusions).
                aligned = []
                for i in range(disp.shape[0]):
                    d = disp[i]
                    if ref is None:
                        ref = d
                    else:
                        scale, shift = _affine_to_ref(d, ref)
                        if 0.25 < float(scale) < 4.0:
                            d = (d * scale + shift).clamp(min=0.0)
                    aligned.append(d)
                disp = torch.stack(aligned)
            # fp16 buffer: same precision the VDA path stores scenes at
            chunks.append(disp.to(torch.float16))
            on_batch(b1 - first)
        return torch.cat(chunks)

    def _normalize(self, disp: "torch.Tensor", disp_range: tuple[float, float] | None) -> "torch.Tensor":
        """Map disparity to [0, 1]: job-wide affine for metric models,
        per-scene min-max for relative ones (see module docstring)."""
        disp = disp.float()
        if disp_range is not None:
            lo, hi = disp_range
            return ((disp - lo) / (hi - lo)).clamp(0.0, 1.0)
        # robust percentiles, not min-max: one outlier frame in a scene
        # (imperfect alignment fit, model spike) would otherwise stretch
        # the range and crush the whole scene toward black (observed)
        flat = disp.flatten()
        if flat.numel() > 8_000_000:
            flat = flat[:: flat.numel() // 8_000_000 + 1]
        lo, hi = torch.quantile(flat, torch.tensor([0.005, 0.995])).tolist()
        return ((disp - lo) / (hi - lo + 1e-8)).clamp(0.0, 1.0)

    def _estimate_disparity_range(self, decoder, total_frames: int, batch_size: int, infer,
                                  invert: bool = True) -> tuple[float, float]:
        """Quick first pass for metric models: p1/p99 of disparity over
        ~RANGE_SAMPLE_FRAMES frames sampled uniformly across the video,
        so one affine mapping holds for the whole job."""
        n = min(RANGE_SAMPLE_FRAMES, total_frames)
        indices = sorted({round(i * (total_frames - 1) / max(n - 1, 1)) for i in range(n)})
        samples: list[torch.Tensor] = []
        for b0 in range(0, len(indices), batch_size):
            batch = indices[b0 : b0 + batch_size]
            frames = torch.stack([decoder[i] for i in batch])
            raw = infer(frames)
            disp = raw.clamp(min=DEPTH_EPS).reciprocal() if invert else raw.clamp(min=0.0)
            # subsample pixels: torch.quantile is capped at ~16M elements
            flat = disp.flatten()
            samples.append(flat[:: max(1, flat.numel() // 500_000)])
        pooled = torch.cat(samples)
        lo, hi = torch.quantile(pooled, torch.tensor([0.01, 0.99])).tolist()
        if hi - lo < 1e-6:  # near-constant depth: avoid amplifying noise
            hi = lo + 1e-6
        return (lo, hi)


def _affine_to_ref(pred: "torch.Tensor", target: "torch.Tensor", max_px: int = 100_000):
    """Least-squares (scale, shift) mapping pred -> target over a pixel
    subsample (closed-form 2x2 solve, same math as the VDA alignment)."""
    import torch

    p = pred.flatten()
    t = target.flatten()
    stride = max(1, p.numel() // max_px)
    p, t = p[::stride].float(), t[::stride].float()
    a00 = (p * p).sum()
    a01 = p.sum()
    a11 = torch.tensor(float(p.numel()))
    b0 = (p * t).sum()
    b1 = t.sum()
    det = a00 * a11 - a01 * a01
    if det.abs() < 1e-12:
        return b0 / (a00 + 1e-6), torch.tensor(0.0)
    return (a11 * b0 - a01 * b1) / det, (-a01 * b0 + a00 * b1) / det


@app.cls(
    gpu=FRAME_DEPTH_GPU,
    image=depth_models_image,
    volumes=GPU_VOLUMES,
    secrets=[hf_secret, slack_secret],
    cpu=4,
    memory=(4 * 1024, 128 * 1024),
    # Adaptive profiling is DECOUPLED from the main per-frame depth pass
    # (FrameDepthWorker.generate, timeout=4h). The profiler loads depth
    # for only 3 keyframes per shot (first / middle / last), so the work
    # is BOUNDED: ~3 × num_scenes keyframe inferences at ~0.3-0.5s each.
    # Even a few hundred keyframes is a couple of minutes worst case, and
    # in practice a whole clip profiles in ~15-25s. A 10-minute timeout is
    # therefore a wide margin for legitimate work while still catching a
    # hung profiler in MINUTES — instead of letting it sit for hours under
    # the depth worker's 4h timeout, which was the whole point of the split.
    timeout=600,  # 10 min — generous for many-shot profiling, tight on hangs
    scaledown_window=SCALEDOWN_WINDOW,
    # profiling is cheap and idempotent, so a transient hang / preemption
    # should re-run cheaply rather than fail the job
    retries=modal.Retries(max_retries=2, initial_delay=10.0, backoff_coefficient=2.0),
)
class ShotProfiler:
    """Adaptive shot profiler — the bounded 3-keyframe-per-shot pass that
    chooses per-shot stereo parameters, decoupled from FrameDepthWorker so
    it runs on its OWN function with a tight 10-min timeout + retries
    (rather than inheriting the depth worker's 4h timeout). Shares the
    model load + inference adapters with FrameDepthWorker via the
    module-level ``_build_model`` / ``_make_infer`` / ``_infer_*`` helpers,
    so the profiling depth math is byte-identical regardless of which
    class runs it."""

    model_name: str = modal.parameter(default="da3-metric")

    @modal.enter()
    def load(self) -> None:
        if self.model_name not in DEPTH_MODELS:
            raise ValueError(f"unknown depth model {self.model_name!r}, expected one of {DEPTH_MODELS}")
        start = time.perf_counter()
        torch.backends.cudnn.benchmark = True
        self.metric = self.model_name in METRIC_MODELS
        # per-frame horizontal-FOV samples (depth-pro only): the infer
        # closure appends one value per frame; profile_scenes resets the
        # list per scene and turns it into per-keyframe stats
        self._fov_samples: list[float] = []
        self.model = _build_model(self.model_name)
        logger.info(f"🚀 {self.model_name} loaded in {time.perf_counter() - start:.1f}s")

    @modal.exit()
    def flush(self) -> None:
        # also runs on preemption (30s grace); profiling writes nothing to
        # checkpoint, but commit keeps the exit contract symmetric with
        # FrameDepthWorker (and persists any job-metadata side writes)
        cache_volume.commit()

    def _make_infer(self, source_shape: tuple[int, int], input_size: int):
        """Delegate to the shared module-level ``_make_infer`` (same
        binding for both worker classes), threading this worker's
        ``_fov_samples`` list so the depth-pro path accumulates per-frame
        FOV estimates the same way it always has."""
        return _make_infer(
            self.model, self.model_name, source_shape, input_size, self._fov_samples
        )

    @modal.method()
    @fail_fast
    def profile_scenes(
        self,
        job_id: str,
        input_path: str,
        scene_ranges: list,
        input_size: int = 518,
        auto_comfort: bool = True,
        comfort_budget: float = MAX_BACKGROUND_DISPARITY,
        depth_scale: float = 1.0,
    ) -> list[dict]:
        """Adaptive per-shot depth script (R&D prototype): analyze 3
        keyframes (first / middle / last) of every scene with the
        metric depth model and choose stereo parameters per shot.

        v3 (model_name="depth-pro"): Depth Pro returns TRUE metric
        meters (no focal normalization), so classification uses the
        tight meters thresholds (units="meters"), and its per-keyframe
        horizontal-FOV estimates are captured into the stats
        ("fov_deg") to bias classification by lens character — see
        _classify_keyframe and docs/DEPTH_SCRIPT.md.

        ``auto_comfort`` (default True): when the user did NOT pass an
        explicit ``depth_scale`` (i.e. it is left at 1.0), build the
        script at scale 1.0, measure the p95 of |screen_disp_in/out|
        across shots, and if that exceeds ``comfort_budget`` (default
        MAX_BACKGROUND_DISPARITY = 0.025, the broadcast background-
        divergence bracket) REBUILD the script at the toned-down scale
        so cut-matching and comfort recompute proportionally. It only
        ever tones DOWN (scale clamped to [0.3, 1.0]). An explicit
        ``depth_scale != 1.0`` is a manual override and WINS — auto-
        comfort is skipped. See _auto_comfort_scale / _apply_auto_comfort.

        Why keyframes instead of every frame: the goal is a per-SHOT
        decision (displacement + screen-plane placement are perceptual
        settings that must be constant within a shot anyway), and three
        frames are enough to tell a static close-up from a wide from a
        shot whose depth composition is changing.

        Why the disparity range comes from the keyframes themselves
        rather than ``_estimate_disparity_range``: profiling already
        decodes and infers 3 frames per scene spread across the whole
        video — pooling those gives the same job-wide p1/p99 estimate
        without a second sampling pass, and keeps the near_fraction
        statistic focal-invariant (a constant per-video focal scale
        cancels in the normalization).

        Classification precedence: ``dynamic`` is tested FIRST — when
        the three keyframes disagree strongly, the scene-level median /
        near_fraction are averages over different compositions and
        cannot be trusted to call close-up/wide, so the conservative
        profile wins. Then close-up, then wide, else standard.

        Script construction (classification, the v1 displacement-step
        clamp, and the pro-treatment v2 mechanisms: depth-matched cuts,
        comfort budget, intra-shot keyframe ramps for dynamic shots)
        lives in the pure-python module-level ``_build_depth_script``
        — see its docstring and docs/DEPTH_SCRIPT.md.

        Returns [{"first", "last", "shot_type", "displacement",
        "placement", "median", "near_fraction", "screen_disp_in",
        "screen_disp_out", optional "keyframes", optional
        "adjustments"}, ...] covering ``scene_ranges`` in order — the
        contract consumed by VideoStereoWorker.generate(scene_params=...).
        """
        if input_size % 14 != 0:
            raise ValueError(f"input_size must be a multiple of 14, got {input_size}")
        if not self.metric:
            raise ValueError(
                f"profile_scenes requires a metric depth model (the absolute "
                f"thresholds are calibrated for 'da3-metric' units or "
                f"'depth-pro' meters), got {self.model_name!r}"
            )
        if not scene_ranges:
            raise ValueError("scene_ranges must contain at least one (first, last) range")
        safe_reload(cache_volume)  # pick up files written by upstream stages
        src = Path(input_path)
        if not src.exists():
            raise FileNotFoundError(f"input video not found: {src}")

        decoder = VideoDecoder(str(src), device="cpu", num_ffmpeg_threads=0)
        meta = decoder.metadata
        if meta.height is None or meta.width is None:
            raise ValueError(f"could not read dimensions of {src}")
        infer = self._make_infer((meta.height, meta.width), input_size)
        ranges = [(int(first), int(last)) for first, last in scene_ranges]
        jlog = job_logger(job_id)

        with jobs.stage_timer(
            job_id, "profile_scenes",
            gpu=torch.cuda.get_device_name(0).replace("NVIDIA ", ""),
            input_size=input_size, model=self.model_name, scenes=len(ranges),
        ):
            # v3: depth-pro profiles in TRUE meters and emits per-frame
            # FOV estimates (the infer closure appends one per frame)
            collect_fov = self.model_name == "depth-pro"
            units = "meters" if self.model_name == "depth-pro" else "da3_metric"

            # pass 1 — depth on each scene's keyframes; keep a pixel
            # subsample of disparity per keyframe for the statistics
            kf_fps = float(meta.average_fps) if meta.average_fps else 24.0
            per_scene: list[dict] = []
            for first, last in ranges:
                # adaptive: ~1 keyframe / 2 s, clamped [3, 12]; long shots
                # get more samples so the ramp follows non-linear moves
                keyframes = _sample_keyframes(first, last, kf_fps)
                frames = torch.stack([decoder[i] for i in keyframes])
                if collect_fov:
                    self._fov_samples = []
                depth = infer(frames).float()  # (k, h, w)
                flat_depth = depth.flatten(1)
                stride = max(1, flat_depth.shape[1] // PROFILE_PIXEL_SAMPLES)
                depth_sub = flat_depth[:, ::stride]  # (k, n)
                per_scene.append({
                    "first": first,
                    "last": last,
                    "keyframes": keyframes,
                    "disp": depth_sub.clamp(min=DEPTH_EPS).reciprocal(),
                    "median_depth": depth_sub.median(dim=1).values,  # per keyframe
                    # per-keyframe horizontal FOV (depth-pro only)
                    "fov_deg": list(self._fov_samples) if collect_fov else None,
                })
                del frames, depth, flat_depth, depth_sub

            # job-wide disparity range over the pooled keyframes — same
            # robust p1/p99 policy as _estimate_disparity_range
            pooled = torch.cat([s["disp"].flatten() for s in per_scene])
            if pooled.numel() > 8_000_000:  # torch.quantile caps at ~16M
                pooled = pooled[:: pooled.numel() // 8_000_000 + 1]
            lo, hi = torch.quantile(pooled, torch.tensor([0.01, 0.99])).tolist()
            if hi - lo < 1e-6:  # near-constant depth: avoid amplifying noise
                hi = lo + 1e-6
            jlog.info(f"📏 profiling disparity range (p1, p99) = ({lo:.4g}, {hi:.4g})")

            # pass 2 — reduce each scene's keyframe tensors to plain
            # python stats, then build the script with the pure helper
            # (classification, v1 clamp, v2 depth-matched cuts +
            # comfort budget + dynamic-shot keyframe ramps)
            per_scene_stats: list[dict] = []
            for s in per_scene:
                nd = ((s["disp"] - lo) / (hi - lo)).clamp(0.0, 1.0)  # (k, n)
                # v6: per-keyframe FAR-content normalized disparity — the
                # 5th percentile of nd (low nd = far). 0 ⇒ genuinely deep
                # content present (far plane stays ≈−1.0); high ⇒ nothing
                # deep / flat rear (far plane pulls in, tightening the box).
                # Robust low percentile (not min) so a few stray far pixels
                # don't anchor the box to noise.
                far_nd = torch.quantile(
                    nd, PROFILE_FAR_PERCENTILE, dim=1
                )  # (k,)
                stat = {
                    "first": s["first"],
                    "last": s["last"],
                    "keyframes": list(s["keyframes"]),
                    "median_depth": [float(v) for v in s["median_depth"]],
                    "median_disp": [float(v) for v in s["disp"].median(dim=1).values],
                    "near_fraction": [
                        float(v) for v in (nd > PROFILE_NEAR_BAND).float().mean(dim=1)
                    ],
                    "far_nd": [float(v) for v in far_nd],  # v6 per-shot far plane
                    "units": units,  # depth-unit flag for the stats consumer
                }
                if s["fov_deg"] is not None:
                    stat["fov_deg"] = [float(v) for v in s["fov_deg"]]
                per_scene_stats.append(stat)
            script, applied_scale = _apply_auto_comfort(
                per_scene_stats, lo, hi, units=units,
                auto_comfort=auto_comfort, comfort_budget=comfort_budget,
                depth_scale=depth_scale,
            )
            # expose the effective scale in job metadata (return contract
            # stays the script list, so consumers are untouched)
            jobs.update_job(job_id, comfort_scale=applied_scale)
            # log the auto-comfort decision (measure once at scale 1.0
            # for the human-readable p95, regardless of outcome)
            if depth_scale != 1.0:
                jlog.info(
                    f"🎛  auto_comfort: skipped (explicit depth_scale="
                    f"{depth_scale} overrides), scale {applied_scale}"
                )
            elif auto_comfort:
                base = _build_depth_script(per_scene_stats, lo, hi, units=units)
                measured = _percentile(
                    sorted(
                        abs(float(e[k])) for e in base
                        for k in ("screen_disp_in", "screen_disp_out") if k in e
                    ),
                    0.95,
                )
                if applied_scale < 1.0:
                    jlog.info(
                        f"🎛  auto_comfort: measured p95 disparity {measured:.5f}, "
                        f"target {comfort_budget} → scale {applied_scale} (rebuilding)"
                    )
                else:
                    jlog.info(
                        f"🎛  auto_comfort: clip within budget "
                        f"(p95 {measured:.5f} ≤ {comfort_budget}), scale 1.0"
                    )

            for entry in script:
                jlog.info(
                    f"🎛  shot [{entry['first']}, {entry['last']}): {entry['shot_type']} "
                    f"disp={entry['displacement']} placement={entry['placement']} "
                    f"(median={entry['median']}, near_fraction={entry['near_fraction']}, "
                    f"screen_disp in/out={entry['screen_disp_in']}/{entry['screen_disp_out']}"
                    + (f", fov={entry['fov_deg']}°" if "fov_deg" in entry else "")
                    + ")"
                )
                for note in entry.get("adjustments", []):
                    jlog.info(
                        f"🎛  shot [{entry['first']}, {entry['last']}): {note}"
                    )

        del decoder  # drop decoder file handles before the next input
        torch.cuda.empty_cache()
        return script
