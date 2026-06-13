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
DEPTH_MODELS = ("da3", "da3-metric", "depth-pro")
METRIC_MODELS = ("da2-metric-indoor", "da2-metric-outdoor", "da3-metric", "depth-pro")
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
# "strong disagreement" between the 3 keyframes: spread of the per-frame
# median normalized disparity (the scene's depth center moved by >30% of
# the job's whole disparity range) or of the per-frame near_fraction
# (>25 pp of the image entered/left the near band) — both indicate the
# shot has large subject/camera motion and one static profile would lie.
PROFILE_DYNAMIC_DISP_SPREAD = 0.30
PROFILE_DYNAMIC_NEAR_SPREAD = 0.25
# Depth continuity: adjacent shots may differ by at most this much
# displacement, so the eye never gets yanked across a cut.
PROFILE_MAX_DISPLACEMENT_STEP = 0.005
# Pixels kept per keyframe for the profiling statistics (medians and
# fractions converge long before this; keeps memory flat per scene).
PROFILE_PIXEL_SAMPLES = 200_000

# ---------------------------------- pro treatment v2 (stereographer)
# Depth-matched cuts: max allowed jump of the SALIENT screen disparity
# (the median-depth content the viewer is looking at) across a cut, as
# a fraction of frame width. 0.2% of width is small enough that the
# eyes re-converge without a noticeable vergence jerk.
CUT_DISPARITY_TOLERANCE = 0.002
# Comfort budget: background divergence (behind-screen disparity of the
# farthest content) ≤ 2% of width — roughly the broadcast divergence
# limit; pop-out (in-front-of-screen disparity) ≤ 0.8% of width.
MAX_BACKGROUND_DISPARITY = 0.02
MAX_POPOUT_DISPARITY = 0.008
# Bounds for cut-matching placement shifts: the far plane may never be
# pushed below −1.3 × max_disp nor the near plane above +0.6 × max_disp
# (beyond these the comfort budget could not be honored by any sane
# displacement, and the depth budget geometry degenerates).
PLACEMENT_SHIFT_MIN = -1.3
PLACEMENT_SHIFT_MAX = 0.6

# Per-shot stereo parameters. ``displacement`` is the max disparity as a
# fraction of width (VideoStereoWorker convention); ``placement`` is the
# DepthSplatter depth-budget mapping (see app/stages/splat.py):
# - close_up: small displacement + pop-out capped at 0.1 — a face filling
#   the frame at full budget causes eye strain and window violations.
# - wide: largest displacement, everything at/behind the screen plane —
#   distant content tolerates (and needs) more disparity to read as deep.
# - dynamic: conservative middle ground — keyframes disagree, so any
#   aggressive setting will be wrong for part of the shot.
# - standard: the pipeline's existing defaults, byte-identical behavior.
SHOT_PARAMS: dict[str, dict] = {
    "close_up": {"displacement": 0.008, "placement": (-1.0, 0.1)},
    "wide":     {"displacement": 0.018, "placement": (-1.0, 0.0)},
    "dynamic":  {"displacement": 0.010, "placement": (-1.0, 0.3)},
    "standard": {"displacement": 0.0125, "placement": (-1.0, 0.5)},
}


# ------------------------------------------ depth-script construction
#
# Everything below is pure python (no torch) so the script-building
# math is testable offline; profile_scenes converts its tensors to
# plain floats/lists before calling _build_depth_script. See
# docs/DEPTH_SCRIPT.md for the full algorithm write-up.

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


def _build_depth_script(
    per_scene_stats: list, lo: float, hi: float, units: str = "da3_metric",
    depth_scale: float = 1.0,
) -> list:
    """Build the per-shot depth script from plain-python keyframe stats
    (pro treatment v2 + FOV-informed v3). Pure function, no torch —
    testable offline.

    ``per_scene_stats``: one dict per shot, in shot order:
      {"first": int, "last": int,
       "keyframes": [abs frame index, ...],           # sorted, 1–3
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
        entry = {
            "first": int(s["first"]),
            "last": int(s["last"]),
            "shot_type": shot_type,
            "displacement": round(params["displacement"] * depth_scale, 6),
            "placement": list(params["placement"]),
            "median": round(median_depth, 4),
            "near_fraction": round(near_fraction, 4),
        }
        if fov_mean is not None:
            entry["fov_deg"] = round(fov_mean, 1)
        if shot_type == "dynamic":
            entry["keyframes"] = [
                {
                    "index": int(idx),
                    "displacement": round(SHOT_PARAMS[
                        _classify_keyframe(d, nf, units=units, fov_deg=fov_mean)
                    ]["displacement"] * depth_scale, 6),
                    "placement": list(SHOT_PARAMS[
                        _classify_keyframe(d, nf, units=units, fov_deg=fov_mean)
                    ]["placement"]),
                }
                for idx, d, nf in zip(s["keyframes"], depth_med, near)
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


with depth_models_image.imports():
    import ffmpeg
    import torch
    import torchvision.transforms.v2 as v2
    from torchcodec.decoders import VideoDecoder

    from app.common.weights import ensure_da2_metric, ensure_da3, ensure_depth_pro


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


@app.cls(
    gpu=FRAME_DEPTH_GPU,
    image=depth_models_image,
    volumes=GPU_VOLUMES,
    secrets=[hf_secret, slack_secret],
    cpu=4,
    memory=(4 * 1024, 128 * 1024),
    timeout=3600,
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
        if self.model_name.startswith("da2-metric"):
            from transformers import DepthAnythingForDepthEstimation

            variant = self.model_name.rsplit("-", 1)[-1]  # indoor | outdoor
            self.model = (
                DepthAnythingForDepthEstimation.from_pretrained(str(ensure_da2_metric(variant)))
                .to("cuda")
                .eval()
            )
        elif self.model_name == "depth-pro":
            import dataclasses

            from depth_pro.depth_pro import DEFAULT_MONODEPTH_CONFIG_DICT, create_model_and_transforms

            config = dataclasses.replace(
                DEFAULT_MONODEPTH_CONFIG_DICT, checkpoint_uri=str(ensure_depth_pro())
            )
            # fp16 per the official CLI; the returned transform is
            # discarded — it targets PIL/ndarray input, while this
            # worker normalizes decoded uint8 tensors itself (see
            # _make_infer)
            self.model, _ = create_model_and_transforms(
                config=config, device=torch.device("cuda"), precision=torch.half
            )
            self.model.eval()
        else:
            from depth_anything_3.api import DepthAnything3

            checkpoint = ensure_da3("mono-large", metric=self.model_name == "da3-metric")
            self.model = DepthAnything3.from_pretrained(str(checkpoint)).to("cuda")
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

            disp_range: tuple[float, float] | None = None
            if self.metric:
                disp_range = self._estimate_disparity_range(decoder, total_frames, batch_size, infer)
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

    @modal.method()
    @fail_fast
    def profile_scenes(
        self,
        job_id: str,
        input_path: str,
        scene_ranges: list,
        input_size: int = 518,
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
            per_scene: list[dict] = []
            for first, last in ranges:
                keyframes = sorted({first, first + (last - 1 - first) // 2, last - 1})
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
                stat = {
                    "first": s["first"],
                    "last": s["last"],
                    "keyframes": list(s["keyframes"]),
                    "median_depth": [float(v) for v in s["median_depth"]],
                    "median_disp": [float(v) for v in s["disp"].median(dim=1).values],
                    "near_fraction": [
                        float(v) for v in (nd > PROFILE_NEAR_BAND).float().mean(dim=1)
                    ],
                    "units": units,  # depth-unit flag for the stats consumer
                }
                if s["fov_deg"] is not None:
                    stat["fov_deg"] = [float(v) for v in s["fov_deg"]]
                per_scene_stats.append(stat)
            script = _build_depth_script(
                per_scene_stats, lo, hi, units=units, depth_scale=depth_scale
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

    # -------------------------------------------------------- inference

    def _make_infer(self, source_shape: tuple[int, int], input_size: int):
        """Bind a ``(T, C, H, W) uint8 cpu -> (T, h, w) float32 cpu raw
        depth`` function for this call's video geometry."""
        if self.model_name.startswith("da2-metric"):
            resize_shape = _resize_shape(source_shape, input_size)
            # Official DA2 preprocessing: aspect-preserving resize to
            # multiples of 14 + ImageNet stats, no padding (≤7 px of
            # aspect distortion from the rounding).
            pre = torch.nn.Sequential(
                v2.ToDtype(torch.float32, scale=True),
                v2.Resize(size=resize_shape, interpolation=v2.InterpolationMode.BICUBIC, antialias=True),
                v2.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
            )
            return lambda frames: self._infer_da2(frames, pre)
        if self.model_name == "depth-pro":
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
            return lambda frames: self._infer_depth_pro(frames, pre)
        return lambda frames: self._infer_da3(frames, input_size)

    def _infer_da2(self, frames: "torch.Tensor", pre) -> "torch.Tensor":
        """transformers DA2-metric: returns depth in meters at the
        working resolution."""
        with torch.no_grad(), torch.autocast(device_type="cuda"):
            depth = self.model(pixel_values=pre(frames.cuda())).predicted_depth  # (T, h, w)
        return depth.float().cpu()

    def _infer_da3(self, frames: "torch.Tensor", input_size: int) -> "torch.Tensor":
        """DA3 api: its InputProcessor handles resize (short side =
        input_size via lower_bound_resize, matching the VDA working-
        resolution convention) + ImageNet normalization. With
        ``alt_start=-1`` in the mono/metric presets there is no
        cross-view attention, so batching frames cannot couple them."""
        imgs = [f.permute(1, 2, 0).contiguous().numpy() for f in frames]  # HWC RGB uint8
        prediction = self.model.inference(
            imgs, process_res=input_size, process_res_method="lower_bound_resize"
        )
        return torch.from_numpy(prediction.depth).float()  # (T, h, w)

    def _infer_depth_pro(self, frames: "torch.Tensor", pre) -> "torch.Tensor":
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
        ``self._fov_samples`` for per-scene means. FOV is invariant to
        uniform resizing, so the working-resolution resize (≤7 px of
        aspect rounding) does not bias it.
        """
        import math

        x = pre(frames.cuda()).half()
        width = x.shape[-1]
        depths = []
        for i in range(x.shape[0]):
            out = self.model.infer(x[i])
            depths.append(out["depth"].float().cpu())  # (h, w) meters
            f_px = float(out["focallength_px"])
            self._fov_samples.append(math.degrees(2.0 * math.atan(width / (2.0 * f_px))))
        return torch.stack(depths)

    def _scene_disparity(
        self, decoder, first: int, last: int, batch_size: int, infer, on_batch,
        align_frames: bool = False,
    ) -> "torch.Tensor":
        """Raw disparity 1/depth (N, h, w) float16 on CPU for one scene.
        on_batch(done_in_scene) fires per inference batch.

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
            disp = depth.clamp(min=DEPTH_EPS).reciprocal().float()
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

    def _estimate_disparity_range(self, decoder, total_frames: int, batch_size: int, infer) -> tuple[float, float]:
        """Quick first pass for metric models: p1/p99 of disparity over
        ~RANGE_SAMPLE_FRAMES frames sampled uniformly across the video,
        so one affine mapping holds for the whole job."""
        n = min(RANGE_SAMPLE_FRAMES, total_frames)
        indices = sorted({round(i * (total_frames - 1) / max(n - 1, 1)) for i in range(n)})
        samples: list[torch.Tensor] = []
        for b0 in range(0, len(indices), batch_size):
            batch = indices[b0 : b0 + batch_size]
            frames = torch.stack([decoder[i] for i in batch])
            disp = infer(frames).clamp(min=DEPTH_EPS).reciprocal()
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
