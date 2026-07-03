"""Content-addressed artifact reuse (preprocess / depth / scenes).

Instead of passing an explicit ``reuse_*_from`` job id, the pipeline
derives a deterministic CACHE KEY from the inputs that affect a stage,
looks it up in a Modal Dict, and reuses the published artifact on GCS if
a match exists — automatically, no job id required.

Keys are layered so a stage's key includes everything upstream that could
change its output:

- preprocess: (input_path, remove_black_bars, output spec, target_fps, trim)
  → the work file is byte-identical for an identical key.
- depth: (depth_source_key — the OUTPUT-RESOLUTION-INDEPENDENT source
  identity — plus depth_model, input_size, encoder, scene-boundary
  identity) → depth is a function of the frames' content/count AND the
  depth settings AND where per-scene normalization resets; the preset's
  output spec deliberately does NOT fragment it (the model resizes to
  input_size, the stereo stage rescales the artifact to any work dims).
- scenes: (preprocess_key) → scene cuts depend only on the work file.

Safety: a key match means the artifact is *interchangeable*. The lookup
ALSO verifies the published GCS file still exists (cache entries outlive
files if GCS is cleaned), so a stale entry degrades to a recompute, never
a wrong reuse. Per-stage skip flags bypass the lookup entirely.

The registry Dict is per-env (shared across the R&D workspaces via the
same APP_ENV, like the jobs Dict), so a reuse produced on one workspace is
found by another — same cross-workspace property the GCS depth reuse has.
"""

import hashlib
import json
import time

import modal

from app.env import APP_ENV

# stage:cache_key -> {"job_id", "gcs_relpath", "created_at", "meta"}
reuse_dict = modal.Dict.from_name(f"stereo3d-reuse-{APP_ENV}", create_if_missing=True)

# stage names (also the skip-flag suffix: skip_reuse_<stage>)
PREPROCESS = "preprocess"
DEPTH = "depth"
SCENES = "scenes"


def _canonical(d: dict) -> str:
    """Stable JSON of a dict for hashing — sorted keys, no whitespace, so
    the same logical inputs always hash identically regardless of order."""
    return json.dumps(d, sort_keys=True, separators=(",", ":"), default=str)


def compute_key(stage: str, inputs: dict) -> str:
    """Deterministic cache key for ``stage`` from its ``inputs`` dict.
    Include EVERY input that changes the stage's output; omit anything that
    doesn't (e.g. inpaint settings never affect depth)."""
    payload = _canonical({"stage": stage, **inputs})
    return f"{stage}:{hashlib.sha256(payload.encode()).hexdigest()[:24]}"


def preprocess_key(
    input_path: str,
    remove_black_bars: bool,
    target_short_side,
    target_height,
    target_fps,
    trim,
    crop_override=None,
) -> str:
    """Key for a preprocess result. trim is the resolved (first, last) or
    None; target_* are the output-resolution spec; target_fps the
    decimation request (None = source rate). crop_override (explicit
    "W:H:X:Y") changes the work file too, so it MUST be in the key — else a
    forced-crop run reuses a no-crop cached work file. Any change → different
    work file → different key."""
    return compute_key(PREPROCESS, {
        "input_path": str(input_path),
        "remove_black_bars": bool(remove_black_bars),
        "target_short_side": target_short_side,
        "target_height": target_height,
        "target_fps": target_fps,
        "trim": list(trim) if trim else None,
        "crop_override": str(crop_override).removeprefix("crop=") if crop_override else None,
    })


def depth_source_key(
    input_path: str,
    remove_black_bars: bool,
    target_fps,
    trim,
    crop_override=None,
) -> str:
    """SOURCE identity for the depth stage — like preprocess_key but
    WITHOUT the output-resolution spec (target_short_side/target_height).

    Depth is deliberately preset-independent: the model resizes its input
    frames to ``input_size`` regardless of the work file's resolution, and
    the stereo stage rescales the depth map to each run's own work dims —
    so the depth map computed under the Depth page's draft preset is the
    SAME artifact a 4k production run needs. Keying depth on the full
    preprocess key silently fragmented the cache by preset (draft and
    1080p shared target_height 1080 and reused; qhd/3k/4k never hit).
    Everything that changes frame CONTENT or COUNT stays in the key:
    crop, fps decimation, trim."""
    return compute_key(PREPROCESS, {
        "input_path": str(input_path),
        "remove_black_bars": bool(remove_black_bars),
        "depth_source_identity": True,  # marker: never collides with a real pp_key
        "target_fps": target_fps,
        "trim": list(trim) if trim else None,
        "crop_override": str(crop_override).removeprefix("crop=") if crop_override else None,
    })


def depth_key(src_key: str, depth_model: str, input_size: int, encoder,
              scene_cuts=None, passthrough=None) -> str:
    """Key for a depth map: the depth SOURCE identity (depth_source_key —
    output-resolution-independent) plus the depth model + resolution +
    encoder + the SCENE-BOUNDARY identity. Earlier revisions passed the
    full preprocess key here, which fragmented the cache by preset; the
    switch to depth_source_key orphaned those entries — intended, they
    recompute once. A different input_size is a different depth map, so
    it MUST be in the key.
    Scene boundaries too: per-scene depth alignment/normalization resets at
    cuts, so the same frames rendered under user cuts [100, 400] are NOT the
    artifact for cuts [250]. scene_cuts is the request's raw SOURCE-frame
    cut list (a list, including [] = one scene) and keys as ("user", cuts);
    None means auto-detection and keys as ("auto",) with no cut list —
    detection is deterministic for the same preprocessed content, so "auto"
    alone identifies it. Adding this material invalidated entries registered
    before it existed — intended: those keys were ambiguous across cut
    lists, so a recompute is the correct degradation.

    ``passthrough``: SOURCE-frame scene starts whose depth is BLACK (the
    scene ships as 2D, the AI pass is skipped) — a different passthrough
    set is a different depth artifact. Only keyed when non-empty so every
    pre-existing no-passthrough artifact stays reusable."""
    material = {
        "preprocess_key": src_key,
        "depth_model": depth_model,
        "input_size": int(input_size),
        "encoder": encoder,
        "scene_cuts": (
            ["user", [int(c) for c in scene_cuts]] if scene_cuts is not None
            else ["auto"]
        ),
    }
    if passthrough:
        material["passthrough"] = sorted(int(f) for f in passthrough)
    return compute_key(DEPTH, material)


def scenes_key(pp_key: str) -> str:
    """Scene cuts depend only on the work file."""
    return compute_key(SCENES, {"preprocess_key": pp_key})


def register(key: str, job_id: str, gcs_relpath: str, meta: dict | None = None) -> None:
    """Record that ``key``'s artifact is published at ``gcs_relpath`` (a
    bucket-relative path under the env prefix) by ``job_id``. Idempotent:
    a later run with the same key just refreshes the pointer."""
    reuse_dict[key] = {
        "job_id": job_id,
        "gcs_relpath": gcs_relpath,
        "created_at": time.time(),
        "meta": meta or {},
    }


def register_value(key: str, job_id: str, value) -> None:
    """Cache a small INLINE result (no GCS file) directly in the registry —
    e.g. scene cuts, a JSON list. The value lives in the entry, so reuse is
    a pure Dict read with no file fetch."""
    reuse_dict[key] = {
        "job_id": job_id,
        "value": value,
        "created_at": time.time(),
    }


def lookup_value(key: str):
    """Return the inline cached value for ``key`` (register_value), or None.
    No file-existence check — the value is self-contained."""
    entry = reuse_dict.get(key)
    if entry and "value" in entry:
        return entry["value"]
    return None


def lookup(key: str):
    """Return the registry entry for ``key`` IF its published GCS artifact
    still exists, else None (a stale pointer degrades to recompute — never
    a wrong reuse). Verifying file existence here keeps the registry honest
    against GCS cleanup."""
    entry = reuse_dict.get(key)
    if not entry:
        return None
    from app.common.storage import BUCKET_DIR

    if not (BUCKET_DIR / entry["gcs_relpath"]).exists():
        return None  # published file gone — ignore the stale entry
    return entry


def peek(key: str):
    """Return the raw registry entry for ``key`` (or None) WITHOUT the GCS
    file-existence check. For contexts that don't mount the bucket (the web
    API endpoint) — callers can verify the file separately via its URL.
    Use lookup() inside the pipeline where the mount is present."""
    return reuse_dict.get(key)
