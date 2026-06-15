"""Content-addressed artifact reuse (preprocess / depth / scenes).

Instead of passing an explicit ``reuse_*_from`` job id, the pipeline
derives a deterministic CACHE KEY from the inputs that affect a stage,
looks it up in a Modal Dict, and reuses the published artifact on GCS if
a match exists — automatically, no job id required.

Keys are layered so a stage's key includes everything upstream that could
change its output:

- preprocess: (input_path, remove_black_bars, output spec, target_fps, trim)
  → the work file is byte-identical for an identical key.
- depth: (preprocess_key, depth_model, input_size, encoder) → depth is a
  function of the exact frames AND the depth settings.
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
) -> str:
    """Key for a preprocess result. trim is the resolved (first, last) or
    None; target_* are the output-resolution spec; target_fps the
    decimation request (None = source rate). Any change → different work
    file → different key."""
    return compute_key(PREPROCESS, {
        "input_path": str(input_path),
        "remove_black_bars": bool(remove_black_bars),
        "target_short_side": target_short_side,
        "target_height": target_height,
        "target_fps": target_fps,
        "trim": list(trim) if trim else None,
    })


def depth_key(pp_key: str, depth_model: str, input_size: int, encoder) -> str:
    """Key for a depth map: the EXACT preprocessed frames (pp_key) plus the
    depth model + resolution + encoder. A different input_size is a
    different depth map, so it MUST be in the key."""
    return compute_key(DEPTH, {
        "preprocess_key": pp_key,
        "depth_model": depth_model,
        "input_size": int(input_size),
        "encoder": encoder,
    })


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
