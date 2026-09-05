"""API payload shapes.

TypedDicts document the JSON contracts without runtime validation —
handlers parse plain dicts with explicit ``.get()`` + manual checks
(deliberate: Pydantic class validation caused silent breakage across
library upgrades in the previous project).
"""

from typing import Literal, TypedDict

StereoMode = Literal["left", "right", "both"]
ImageFormat = Literal["lr", "tb", "half_lr", "half_tb", "anaglyph"]
VideoFormat = Literal["sbs", "half_sbs", "tb", "half_tb", "anaglyph"]
InpaintMode = Literal["propainter", "migan", "none"]
# "migan": per-frame MI-GAN hole fill (no temporal model) on the L4 lite
# tier — filled edges at near raw-warp cost. Forward warp only.
# Stereo synthesis method, orthogonal to InpaintMode. "forward" = scatter
# splat with occlusion masks (inpaintable); "backward" = gather warp
# (app-parity kernel, no holes → REQUIRES inpaint "none"; any other
# inpaint value with "backward" is rejected as contradictory).
WarpMethod = Literal["forward", "backward"]


class VideoRequest(TypedDict, total=False):
    input_path: str  # required; bucket-relative, e.g. "inputs/samples/clip.mp4"
    displacement: float  # max disparity as fraction of width (default 0.0125)
    inpaint: InpaintMode  # default "propainter"
    warp: WarpMethod  # default "forward"; "backward" needs inpaint "none"
    input_size: int  # depth model resolution, multiple of 14 (default 980)
    encoder: Literal["vits", "vitl"]  # default "vitl"
    remove_black_bars: bool  # default True
    formats: list[VideoFormat]  # default ["sbs", "half_sbs"] — anaglyph
    # only when explicitly requested (VR-first product)
    include_audio: bool  # default True
    output_depth: bool  # default True
    depth_only: bool  # default False; stop after the depth stage —
    # publish depth.mp4 + depth_vis.mp4 and complete (no stereo warp,
    # no output encodes; formats ignored). The depth artifact still
    # registers for content-addressed reuse. Mutually exclusive with
    # depth_source. Pro Depth step.
    adaptive: bool  # default False; per-shot depth script (R&D prototype,
    # sequential propainter/none path only); decisions appear in
    # metadata["depth_script"]
    profiler: Literal["da3-metric", "depth-pro"]  # default "da3-metric";
    # adaptive profiling backend — only valid with adaptive=true
    # (rejected otherwise). "depth-pro" (v3; R&D only, apple-amlr
    # weights) profiles in TRUE meters (tight 3 m / 11 m close/wide
    # cuts) and uses the shot-mean horizontal FOV as a classification
    # modifier; script entries gain "fov_deg" (shot mean, 1 dp)
    depth_scale: float  # default 1.0, range [0.3, 1.5]; adaptive only.
    # Uniform multiplier on every shot's displacement — tones the whole
    # stereo effect down (<1) or up (>1) while preserving the script's
    # relative structure; comfort caps remain hard limits. An explicit
    # value OVERRIDES auto_comfort (manual wins).
    auto_comfort: bool  # default True; adaptive only. Auto-pick the scale
    # that lands the clip's p95 salient screen disparity within
    # comfort_budget — only ever tones DOWN (never amplifies). Skipped
    # when an explicit depth_scale is given. The chosen scale appears in
    # job metadata as "comfort_scale".
    comfort_budget: float  # default 0.025, range (0, 0.05]; adaptive only.
    # Target peak salient screen disparity (fraction of width) for
    # auto_comfort; 0.025 = the broadcast background-divergence bracket
    # (0.02) lifted 25% with the v7 displacement tables.
    from_frame: int  # trim: keep [from_frame, to_frame) — frame-exact,
    to_frame: int    # canonical. Half-open. Omit start⇒0, end⇒end.
    from_sec: float  # convenience: converted to frames via source fps
    to_sec: float    # (round to nearest). Use from_frame/to_frame for
    # exactness (e.g. depth-reuse alignment). Audio is cut to the same
    # window. Trimming always re-encodes to clean H.264.
    reuse_depth_from: str  # job_id of a prior run on the SAME source
    # (same crop/resolution): skip the depth pass and reuse its cached
    # depth map. Frame count + dimensions are verified; mismatch = 400.
    # For stereo-only experiments (propainter vs m2svid, displacement
    # sweeps) — saves the whole depth stage


class ImageItem(TypedDict, total=False):
    item_id: str  # default derived from filename
    input_path: str  # required
    displacement: float  # default 0.01
    stereo_mode: StereoMode  # default "both"
    warp: WarpMethod  # default "forward" (splat + fill); "backward" skips the fill
    inpaint: Literal["lama", "migan", "none"]  # forward-warp fill model (default lama)
    formats: list[ImageFormat]  # default ["lr"]
    output_depthmap: bool  # default True
    remove_black_bars: bool  # default True


class ImageRequest(TypedDict, total=False):
    items: list[ImageItem]  # required (or use single-item shorthand input_path)
    input_path: str  # shorthand for a single image


class JobSubmitted(TypedDict):
    job_id: str
    status: str
    status_url: str


class JobStatus(TypedDict, total=False):
    job_id: str
    kind: str
    status: str  # pending | in_progress | completed | failed
    stage: str | None
    progress: float
    outputs: dict
    timings: list[dict]
    error: str | None
    created_at: float
    updated_at: float
