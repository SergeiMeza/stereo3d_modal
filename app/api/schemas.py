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
InpaintMode = Literal["propainter", "none"]


class VideoRequest(TypedDict, total=False):
    input_path: str  # required; bucket-relative, e.g. "inputs/samples/clip.mp4"
    displacement: float  # max disparity as fraction of width (default 0.0125)
    inpaint: InpaintMode  # default "propainter"
    input_size: int  # depth model resolution, multiple of 14 (default 980)
    encoder: Literal["vits", "vitl"]  # default "vitl"
    remove_black_bars: bool  # default True
    formats: list[VideoFormat]  # default ["sbs", "half_sbs", "anaglyph"]
    include_audio: bool  # default True
    output_depth: bool  # default True
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
    # relative structure; comfort caps remain hard limits


class ImageItem(TypedDict, total=False):
    item_id: str  # default derived from filename
    input_path: str  # required
    displacement: float  # default 0.01
    stereo_mode: StereoMode  # default "both"
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
